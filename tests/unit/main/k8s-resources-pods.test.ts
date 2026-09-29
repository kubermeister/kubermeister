import { ApiException, type V1Container, type V1ContainerStatus, type V1Pod } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = {
    apis: vi.fn(),
    getActiveNamespace: vi.fn<() => string | null>(),
    resolveNamespace: (explicit?: string) => explicit ?? client.getActiveNamespace() ?? undefined,
    resolveObjectNamespace: (explicit?: string) => explicit ?? client.getActiveNamespace(),
    listItems: async <T>(
        ns: string | undefined,
        namespaced: (ns: string) => Promise<{ items: T[] }>,
        all: () => Promise<{ items: T[] }>,
    ) => {
        const resolved = ns ?? client.getActiveNamespace() ?? undefined;
        return resolved ? namespaced(resolved) : all();
    },
    readOrNull: async <T>(read: () => Promise<T>) => {
        try {
            return await read();
        } catch (error) {
            if (error instanceof ApiException && error.code === 404) return undefined;
            throw error;
        }
    },
};
vi.mock('../../../src/main/k8s/client.js', () => client);
const sampler = { ensureSampler: vi.fn(), containerUsage: vi.fn(() => undefined), podUsage: vi.fn() };
vi.mock('../../../src/main/k8s/sampler.js', () => sampler);

const pods = await import('../../../src/main/k8s/resources/pods.js');

const NOW = Date.parse('2026-09-15T12:00:00Z');
const HOUR = 3600 * 1000;

function status(overrides: Partial<V1ContainerStatus> = {}): V1ContainerStatus {
    return {
        name: 'app',
        ready: true,
        restartCount: 0,
        image: 'nginx',
        imageID: 'docker://sha256@abc',
        state: { running: { startedAt: new Date(NOW - 2 * HOUR) } },
        ...overrides,
    } as V1ContainerStatus;
}
function container(overrides: Partial<V1Container> = {}): V1Container {
    return {
        name: 'app',
        image: 'nginx:1.27',
        ports: [{ containerPort: 80 }],
        resources: { requests: { cpu: '100m' }, limits: { cpu: '500m', memory: '128Mi' } },
        ...overrides,
    } as V1Container;
}
function pod(overrides: Partial<V1Pod> = {}): V1Pod {
    return {
        metadata: {
            name: 'web-1',
            namespace: 'team-a',
            creationTimestamp: new Date(NOW - 3 * 24 * HOUR),
            labels: { app: 'web', 'kubectl.kubernetes.io/last-applied-configuration': '{...}' },
            annotations: { note: 'x' },
        },
        spec: { nodeName: 'n1', containers: [container()], serviceAccountName: 'default', dnsPolicy: 'ClusterFirst' },
        status: {
            phase: 'Running',
            podIP: '10.0.0.5',
            hostIP: '192.168.1.2',
            qosClass: 'Burstable',
            containerStatuses: [status()],
            conditions: [{ type: 'Ready', status: 'True', lastTransitionTime: new Date(NOW - HOUR) }],
        },
        ...overrides,
    } as V1Pod;
}

describe('derivePodStatus', () => {
    it('lets termination and waiting reasons outrank the phase', () => {
        expect(pods.derivePodStatus(pod())).toBe('Running');
        expect(pods.derivePodStatus(pod({ metadata: { deletionTimestamp: new Date() } }))).toBe('Terminating');
        expect(
            pods.derivePodStatus(
                pod({
                    status: {
                        phase: 'Running',
                        containerStatuses: [status({ state: { waiting: { reason: 'CrashLoopBackOff' } } })],
                    },
                }),
            ),
        ).toBe('CrashLoop');
        for (const reason of ['ImagePullBackOff', 'ErrImagePull']) {
            expect(
                pods.derivePodStatus(
                    pod({
                        status: { phase: 'Pending', containerStatuses: [status({ state: { waiting: { reason } } })] },
                    }),
                ),
            ).toBe('Error');
        }
    });

    it('reads a waiting init container, which holds the pod in Pending', () => {
        const initWaiting = (reason: string) =>
            pod({
                status: {
                    phase: 'Pending',
                    initContainerStatuses: [status({ name: 'migrate', state: { waiting: { reason } } })],
                    containerStatuses: [status({ ready: false, state: { waiting: { reason: 'PodInitializing' } } })],
                },
            });
        expect(pods.derivePodStatus(initWaiting('CrashLoopBackOff'))).toBe('CrashLoop');
        expect(pods.derivePodStatus(initWaiting('ImagePullBackOff'))).toBe('Error');
        expect(pods.derivePodStatus(initWaiting('ErrImagePull'))).toBe('Error');
        expect(pods.derivePodStatus(initWaiting('PodInitializing'))).toBe('Pending');
    });

    it('finds a back-off behind another container that is merely waiting', () => {
        const pending = pod({
            status: {
                phase: 'Pending',
                containerStatuses: [
                    status({ name: 'a', state: { waiting: { reason: 'ContainerCreating' } } }),
                    status({ name: 'b', state: { waiting: { reason: 'ImagePullBackOff' } } }),
                ],
            },
        });
        expect(pods.derivePodStatus(pending)).toBe('Error');
    });

    it('maps the remaining phases and falls back to Unknown', () => {
        for (const [phase, expected] of [
            ['Pending', 'Pending'],
            ['Succeeded', 'Succeeded'],
            ['Failed', 'Failed'],
            ['Weird', 'Unknown'],
            [undefined, 'Unknown'],
        ] as const) {
            expect(pods.derivePodStatus(pod({ status: { phase } }))).toBe(expected);
        }
    });
});

describe('toPod', () => {
    it('builds the row with ready ratio, restarts, age, node and summed limits', () => {
        expect(pods.toPod(pod(), NOW)).toEqual({
            name: 'web-1',
            namespace: 'team-a',
            status: 'Running',
            ready: '1/1',
            restarts: 0,
            age: '3d',
            node: 'n1',
            owner: '—',
            cpu: 0,
            mem: 0,
            cpuLimit: 500,
            memLimit: 128,
        });
    });

    it('names the controller that owns the pod, which is how a list groups by workload', () => {
        const owned = pod({
            metadata: {
                name: 'web-1',
                namespace: 'team-a',
                ownerReferences: [
                    { apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-7d9', uid: 'r1', controller: true },
                ],
            },
        });
        expect(pods.toPod(owned, NOW).owner).toBe('ReplicaSet/web-7d9');
    });

    it('counts ready containers and restarts across containers and tolerates missing fields', () => {
        const two = pod({
            spec: { containers: [container(), container({ name: 'sidecar', resources: {} })] },
            status: {
                phase: 'Running',
                containerStatuses: [status(), status({ name: 'sidecar', ready: false, restartCount: 3 })],
            },
        });
        expect(pods.toPod(two, NOW)).toMatchObject({
            ready: '1/2',
            restarts: 3,
            node: '—',
            cpuLimit: 500,
            memLimit: 128,
        });
        expect(pods.toPod({ metadata: {} } as V1Pod, NOW)).toMatchObject({
            name: '',
            namespace: 'default',
            ready: '0/0',
            restarts: 0,
            age: '—',
            status: 'Unknown',
        });
    });
});

describe('toPod with init containers', () => {
    const sidecarSpec = (restartPolicy?: string) =>
        container({ name: 'proxy', resources: {}, ...(restartPolicy ? { restartPolicy } : {}) });

    it('counts native sidecars in the ready ratio, as kubectl does', () => {
        const withSidecar = pod({
            spec: { containers: [container()], initContainers: [sidecarSpec('Always')] },
            status: {
                phase: 'Running',
                initContainerStatuses: [status({ name: 'proxy', ready: true })],
                containerStatuses: [status()],
            },
        });
        expect(pods.toPod(withSidecar, NOW).ready).toBe('2/2');
    });

    it('shows a sidecar that is not ready', () => {
        const unready = pod({
            spec: { containers: [container()], initContainers: [sidecarSpec('Always')] },
            status: {
                phase: 'Running',
                initContainerStatuses: [status({ name: 'proxy', ready: false })],
                containerStatuses: [status()],
            },
        });
        expect(pods.toPod(unready, NOW).ready).toBe('1/2');
    });

    it('leaves ordinary init containers out of the ratio', () => {
        const initOnly = pod({
            spec: { containers: [container()], initContainers: [sidecarSpec()] },
            status: {
                phase: 'Running',
                initContainerStatuses: [
                    status({
                        name: 'proxy',
                        ready: false,
                        state: { terminated: { exitCode: 0, reason: 'Completed' } },
                    }),
                ],
                containerStatuses: [status()],
            },
        });
        expect(pods.toPod(initOnly, NOW).ready).toBe('1/1');
    });

    it('counts init container restarts, so a crash-looping init container shows them', () => {
        const crashing = pod({
            spec: { containers: [container()], initContainers: [sidecarSpec()] },
            status: {
                phase: 'Pending',
                initContainerStatuses: [
                    status({
                        name: 'proxy',
                        ready: false,
                        restartCount: 4,
                        state: { waiting: { reason: 'CrashLoopBackOff' } },
                    }),
                ],
                containerStatuses: [status({ ready: false, state: { waiting: { reason: 'PodInitializing' } } })],
            },
        });
        expect(pods.toPod(crashing, NOW)).toMatchObject({ status: 'CrashLoop', ready: '0/1', restarts: 4 });
    });
});

describe('container and probe transforms', () => {
    it('describes each probe type with its period', () => {
        expect(pods.probeSpec({ httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 10 })).toBe(
            'httpGet /healthz:8080 · 10s',
        );
        expect(pods.probeSpec({ httpGet: { port: 80 } })).toBe('httpGet /:80');
        expect(pods.probeSpec({ tcpSocket: { port: 5432 } })).toBe('tcpSocket :5432');
        expect(pods.probeSpec({ exec: { command: ['cat', '/tmp/ok'] }, periodSeconds: 5 })).toBe(
            'exec cat /tmp/ok · 5s',
        );
        expect(pods.probeSpec({ grpc: { port: 9090 } })).toBe('grpc :9090');
        expect(pods.probeSpec({ periodSeconds: 3 })).toBe('probe · 3s');
        expect(pods.probeSpec(undefined)).toBeNull();
    });

    it('lists only the probes a container defines, in a fixed order', () => {
        const c = container({
            readinessProbe: { tcpSocket: { port: 80 } },
            startupProbe: { exec: { command: ['true'] } },
        });
        expect(pods.containerProbes(c)).toEqual([
            { kind: 'Readiness', spec: 'tcpSocket :80' },
            { kind: 'Startup', spec: 'exec true' },
        ]);
        expect(pods.containerProbes(container())).toEqual([]);
    });

    it('derives the container state from its status', () => {
        expect(pods.containerState(undefined)).toBe('Unknown');
        expect(pods.containerState(status())).toBe('Running');
        expect(pods.containerState(status({ state: { terminated: { reason: 'Completed', exitCode: 0 } } }))).toBe(
            'Completed',
        );
        expect(pods.containerState(status({ state: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }))).toBe(
            'Failed',
        );
        expect(pods.containerState(status({ state: { waiting: { reason: 'CrashLoopBackOff' } } }))).toBe('CrashLoop');
        expect(pods.containerState(status({ state: { waiting: { reason: 'ContainerCreating' } } }))).toBe('Pending');
        expect(pods.containerState(status({ state: {} }))).toBe('Unknown');
    });

    it('orders containers by the part they play: init steps, the app, then anything attached', () => {
        const pod = {
            spec: {
                initContainers: [{ name: 'migrate', image: 'busybox' }],
                containers: [{ name: 'app', image: 'nginx' }],
                ephemeralContainers: [{ name: 'debugger', image: 'busybox' }],
            },
            status: {
                initContainerStatuses: [{ name: 'migrate', restartCount: 0, state: { terminated: { exitCode: 0 } } }],
                containerStatuses: [{ name: 'app', restartCount: 1, state: { running: {} } }],
                ephemeralContainerStatuses: [{ name: 'debugger', restartCount: 0, state: { running: {} } }],
            },
        };
        const containers = pods.toContainers(pod, NOW, (name) => (name === 'app' ? { cpu: 40, mem: 64 } : undefined));
        expect(containers.map((c) => [c.name, c.role])).toEqual([
            ['migrate', 'init'],
            ['app', 'app'],
            ['debugger', 'ephemeral'],
        ]);
        expect(containers[1]).toMatchObject({ cpuUsed: 40, memUsed: 64, restarts: 1 });
        // A container metrics-server has not reported has no usage rather than a zero.
        expect(containers[0]).toMatchObject({ cpuUsed: null, memUsed: null });
    });

    it('builds the container view with resources, ports, image id and start time', () => {
        expect(pods.toContainer(container(), status(), NOW)).toEqual({
            name: 'app',
            role: 'app',
            image: 'nginx:1.27',
            imageId: 'abc',
            pullPolicy: 'IfNotPresent',
            state: 'Running',
            started: '2h ago',
            restarts: 0,
            cpuRequest: '100m',
            cpuLimit: '500m',
            memRequest: '—',
            memLimit: '128Mi',
            ports: ['80/TCP'],
            probes: [],
            // Usage arrives from the sampler, and the request as a number beside it.
            cpuUsed: null,
            memUsed: null,
            cpuRequested: 100,
            memRequested: null,
        });
        expect(pods.toContainer(container(), status(), NOW, 'init', { cpu: 30, mem: 12 })).toMatchObject({
            role: 'init',
            cpuUsed: 30,
            memUsed: 12,
        });
        expect(
            pods.toContainer(
                container({ imagePullPolicy: 'Always', ports: [{ containerPort: 53, protocol: 'UDP' }] }),
                undefined,
                NOW,
            ),
        ).toMatchObject({ pullPolicy: 'Always', state: 'Unknown', started: '—', imageId: '—', ports: ['53/UDP'] });
    });
});

describe('toPodDetail', () => {
    it('adds placement, networking, conditions, containers and filtered metadata', () => {
        const detail = pods.toPodDetail(pod(), NOW);
        expect(detail).toMatchObject({
            podIP: '10.0.0.5',
            hostIP: '192.168.1.2',
            qos: 'Burstable',
            dnsPolicy: 'ClusterFirst',
            serviceAccount: 'default',
        });
        expect(detail.conditions).toEqual([{ type: 'Ready', ok: true, time: '1h ago' }]);
        expect(detail.containers.map((c) => c.name)).toEqual(['app']);
        expect(detail.labels).toEqual([['app', 'web']]);
        expect(detail.annotations).toEqual([['note', 'x']]);
        expect(
            pods.toConditions(pod({ status: { conditions: [{ type: 'PodScheduled', status: 'False' }] } }), NOW),
        ).toEqual([{ type: 'PodScheduled', ok: false, time: '—' }]);
        expect(pods.toPairs(undefined)).toEqual([]);
    });
});

describe('readers', () => {
    const listNamespacedPod = vi.fn();
    const listPodForAllNamespaces = vi.fn();
    const readNamespacedPod = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        client.getActiveNamespace.mockReturnValue('team-a');
        client.apis.mockReturnValue({ core: { listNamespacedPod, listPodForAllNamespaces, readNamespacedPod } });
        listNamespacedPod.mockResolvedValue({ items: [pod()] });
        listPodForAllNamespaces.mockResolvedValue({
            items: [pod(), pod({ metadata: { name: 'other', namespace: 'kube-system' } })],
        });
    });

    it('merges the latest sampled usage into rows and starts the sampler', async () => {
        sampler.podUsage.mockImplementation((ns: string, name: string) =>
            ns === 'team-a' && name === 'web-1' ? { cpu: 250, mem: 64 } : undefined,
        );
        const [row] = await pods.listPods('team-a');
        expect(row).toMatchObject({ cpu: 250, mem: 64, cpuLimit: 500, memLimit: 128 });
        expect(sampler.ensureSampler).toHaveBeenCalled();
        readNamespacedPod.mockResolvedValue(pod());
        await expect(pods.getPod('web-1', 'team-a')).resolves.toMatchObject({ cpu: 250, mem: 64 });
        sampler.podUsage.mockReturnValue(undefined);
        expect((await pods.listPods('team-a'))[0]).toMatchObject({ cpu: 0, mem: 0 });
    });

    it('lists the explicit or active namespace, or everything when none is selected', async () => {
        expect((await pods.listPods('explicit')).map((p) => p.name)).toEqual(['web-1']);
        expect(listNamespacedPod).toHaveBeenCalledWith({ namespace: 'explicit' });
        await pods.listPods();
        expect(listNamespacedPod).toHaveBeenLastCalledWith({ namespace: 'team-a' });
        client.getActiveNamespace.mockReturnValue(null);
        expect((await pods.listPods()).map((p) => p.namespace)).toEqual(['team-a', 'kube-system']);
    });

    it('gets a pod directly, returns null for a missing one, and refuses without a namespace', async () => {
        readNamespacedPod.mockResolvedValue(pod());
        await expect(pods.getPod('web-1', 'team-a')).resolves.toMatchObject({
            name: 'web-1',
            containers: [{ name: 'app' }],
        });
        expect(readNamespacedPod).toHaveBeenCalledWith({ name: 'web-1', namespace: 'team-a' });
        readNamespacedPod.mockRejectedValue(new ApiException(404, 'x', null, {}));
        await expect(pods.getPod('gone')).resolves.toBeNull();
        client.getActiveNamespace.mockReturnValue(null);
        await expect(pods.getPod('web-1')).resolves.toBeNull();
        expect(readNamespacedPod).toHaveBeenCalledTimes(2);
    });

    it('classifies API failures under the generic operation names', async () => {
        listNamespacedPod.mockRejectedValue(new ApiException(403, 'x', { message: 'denied' }, {}));
        await expect(pods.listPods()).rejects.toMatchObject({ kind: 'forbidden', op: 'resources.list' });
        readNamespacedPod.mockRejectedValue(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
        await expect(pods.getPod('web-1', 'team-a')).rejects.toMatchObject({
            kind: 'unreachable',
            op: 'resources.get',
        });
    });
});
