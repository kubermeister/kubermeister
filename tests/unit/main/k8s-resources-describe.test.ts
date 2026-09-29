import { ApiException, type CoreV1Event, type V1Node, type V1Pod } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = {
    readNamespacedPod: vi.fn(),
    listNode: vi.fn(),
    readNode: vi.fn(),
    listPodForAllNamespaces: vi.fn(),
    listNamespacedEvent: vi.fn(),
    listEventForAllNamespaces: vi.fn(),
};
const client = {
    apis: () => ({ core }),
    getActiveNamespace: vi.fn<() => string | null>(() => 'team-a'),
    resolveObjectNamespace: (explicit?: string) => explicit ?? client.getActiveNamespace(),
    isSafeSelectorValue: (value: string) => /^[A-Za-z0-9.-]+$/.test(value),
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

const describeMod = await import('../../../src/main/k8s/resources/describe.js');
const { describeToText } = await import('../../../src/shared/k8s/describe.js');

const NOW = Date.parse('2026-09-16T12:00:00Z');

const pod = (overrides: Partial<V1Pod> = {}): V1Pod =>
    ({
        metadata: {
            name: 'web-1',
            namespace: 'team-a',
            uid: 'pod-1',
            labels: { app: 'web' },
            ownerReferences: [{ kind: 'ReplicaSet', name: 'web-abc', uid: 'rs-1', controller: true }],
        },
        spec: {
            nodeName: 'node-1',
            serviceAccountName: 'default',
            initContainers: [{ name: 'migrate', image: 'busybox' }],
            containers: [
                {
                    name: 'web',
                    image: 'nginx:1.27',
                    ports: [{ containerPort: 80, protocol: 'TCP' }],
                    resources: { requests: { cpu: '100m' }, limits: { cpu: '500m' } },
                    volumeMounts: [{ name: 'data', mountPath: '/data' }],
                    env: [{ name: 'A', value: '1' }],
                },
            ],
            volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'web-data' } }],
            tolerations: [{ key: 'node-role', operator: 'Exists', effect: 'NoSchedule' }],
        },
        status: {
            phase: 'Running',
            podIP: '10.1.2.3',
            qosClass: 'Burstable',
            containerStatuses: [
                { name: 'web', ready: true, restartCount: 2, state: { running: { startedAt: new Date(NOW) } } },
            ],
            initContainerStatuses: [
                {
                    name: 'migrate',
                    ready: true,
                    restartCount: 0,
                    state: { terminated: { exitCode: 0, reason: 'Completed' } },
                },
            ],
            conditions: [{ type: 'Ready', status: 'True' }],
        },
        ...overrides,
    }) as V1Pod;

const event = (reason: string, seconds: number): CoreV1Event =>
    ({
        type: 'Warning',
        reason,
        message: `${reason} happened`,
        count: 3,
        involvedObject: { uid: 'pod-1', name: 'web-1' },
        lastTimestamp: new Date(NOW - seconds * 1000),
    }) as CoreV1Event;

beforeEach(() => {
    vi.clearAllMocks();
    core.readNamespacedPod.mockResolvedValue(pod());
    core.listNamespacedEvent.mockResolvedValue({ items: [event('BackOff', 60)] });
    core.listEventForAllNamespaces.mockResolvedValue({ items: [] });
    core.listPodForAllNamespaces.mockResolvedValue({ items: [pod()] });
});

describe('describing a pod', () => {
    it('reads where it runs, what it runs and what happened, in that order', () => {
        const document = describeMod.describePod(pod(), [event('BackOff', 60)], NOW);
        expect(document.sections.map((s) => s.title)).toEqual([
            'Overview',
            'Containers',
            'Conditions',
            'Volumes',
            'Events',
        ]);
        const overview = Object.fromEntries(document.sections[0]!.rows.map((r) => [r.label, r.value]));
        expect(overview).toMatchObject({
            Node: 'node-1',
            Status: 'Running',
            IP: '10.1.2.3',
            'Controlled by': 'ReplicaSet/web-abc',
            Labels: 'app=web',
        });
        // A field the object does not carry reads as a dash rather than as "undefined".
        expect(overview.Reason).toBe('—');
        expect(overview.Tolerations).toBe('node-role Exists NoSchedule');
    });

    it('gives every container a block, saying which are init containers and what state each is in', () => {
        const containers = describeMod.describePod(pod(), [], NOW).sections[1]!;
        expect(containers.blocks.map((b) => b.title)).toEqual(['migrate (init)', 'web']);
        const web = Object.fromEntries(containers.blocks[1]!.rows.map((r) => [r.label, r.value]));
        expect(web).toMatchObject({
            Image: 'nginx:1.27',
            Ports: '80/TCP',
            Requests: 'cpu=100m',
            Limits: 'cpu=500m',
            Restarts: '2',
            Mounts: '/data from data',
            Environment: '1 variable(s)',
        });
        expect(web.State).toContain('Running since');
        expect(containers.blocks[0]!.rows.find((r) => r.label === 'State')?.value).toContain('Terminated: Completed');
    });

    it('names a volume by the kind of volume it is', () => {
        const volumes = describeMod.describePod(pod(), [], NOW).sections[3]!;
        expect(volumes.rows).toEqual([{ label: 'data', value: 'persistentVolumeClaim (web-data)' }]);
    });

    it('lists events newest first with their repeat count, and says so when there are none', () => {
        const events = describeMod.describePod(pod(), [event('BackOff', 600), event('Unhealthy', 30)], NOW)
            .sections[4]!;
        expect(events.rows[0]!.label).toBe('Warning Unhealthy');
        expect(events.rows[0]!.value).toContain('x3');
        expect(describeMod.describePod(pod(), [], NOW).sections[4]!.rows).toEqual([{ label: '', value: 'No events.' }]);
    });
});

describe('a pod with nothing filled in', () => {
    it('reads every absent field as a dash rather than guessing at one', () => {
        const bare = { metadata: { name: 'loose' }, spec: { containers: [] }, status: {} } as V1Pod;
        const document = describeMod.describePod(bare, [], NOW);
        const overview = Object.fromEntries(document.sections[0]!.rows.map((r) => [r.label, r.value]));
        expect(overview).toMatchObject({
            Namespace: '—',
            Node: '—',
            'Controlled by': '—',
            Labels: '—',
            Tolerations: '—',
            'Node selector': '—',
        });
        expect(document.namespace).toBeNull();
        expect(document.sections[1]!.blocks).toEqual([]);
        expect(document.sections[3]!.rows).toEqual([]);
    });

    it('reads a waiting container, an unnamed volume kind and an event with no repeat', () => {
        const waiting = {
            metadata: { name: 'web-1', namespace: 'team-a' },
            spec: {
                containers: [{ name: 'web', image: 'nginx' }],
                volumes: [{ name: 'tmp', emptyDir: {} }, { name: 'nothing' }],
            },
            status: {
                containerStatuses: [
                    { name: 'web', ready: false, restartCount: 0, state: { waiting: { reason: 'CrashLoopBackOff' } } },
                ],
            },
        } as unknown as V1Pod;
        const document = describeMod.describePod(
            waiting,
            [{ involvedObject: {}, lastTimestamp: new Date(NOW) } as CoreV1Event],
            NOW,
        );
        const container = Object.fromEntries(document.sections[1]!.blocks[0]!.rows.map((r) => [r.label, r.value]));
        expect(container.State).toBe('Waiting: CrashLoopBackOff');
        expect(container.Ready).toBe('false');
        expect(container.Ports).toBe('—');
        // A volume whose type carries no name reads as the type alone; one with no type at all as a dash.
        expect(document.sections[3]!.rows).toEqual([
            { label: 'tmp', value: 'emptyDir' },
            { label: 'nothing', value: '—' },
        ]);
        // An event with no type, reason or count still reads as a line.
        expect(document.sections[4]!.rows[0]!.label).toBe('Normal');
        expect(document.sections[4]!.rows[0]!.value).not.toContain('x');
    });

    it('reads a container terminated with no reason, and a node with no status at all', () => {
        const terminated = {
            metadata: { name: 'job-1', namespace: 'team-a' },
            spec: { containers: [{ name: 'run', image: 'busybox' }] },
            status: { containerStatuses: [{ name: 'run', restartCount: 0, state: { terminated: {} } }] },
        } as unknown as V1Pod;
        const block = describeMod.describePod(terminated, [], NOW).sections[1]!.blocks[0]!;
        expect(block.rows.find((r) => r.label === 'State')?.value).toBe('Terminated: — (exit —)');

        const empty = describeMod.describeNode({ metadata: { name: 'node-9' } } as V1Node, [], [], NOW);
        expect(empty.sections.find((s) => s.title === 'Conditions')!.rows).toEqual([]);
        expect(empty.sections[0]!.rows.find((r) => r.label === 'Taints')?.value).toBe('—');
    });
});

describe('describing a node', () => {
    const node: V1Node = {
        metadata: { name: 'node-1', uid: 'node-uid', labels: { 'node-role.kubernetes.io/control-plane': '' } },
        spec: { unschedulable: true, taints: [{ key: 'node-role', value: 'cp', effect: 'NoSchedule' }] },
        status: {
            conditions: [{ type: 'Ready', status: 'True', reason: 'KubeletReady' } as never],
            addresses: [{ type: 'InternalIP', address: '10.0.0.1' }],
            capacity: { cpu: '4' },
            allocatable: { cpu: '3900m' },
            nodeInfo: { kubeletVersion: 'v1.36.4' } as never,
        },
    } as V1Node;

    it('reads its roles, taints, capacity and the pods it carries', () => {
        const document = describeMod.describeNode(node, [pod()], [], NOW);
        const overview = Object.fromEntries(document.sections[0]!.rows.map((r) => [r.label, r.value]));
        expect(overview).toMatchObject({
            Roles: 'control-plane',
            Unschedulable: 'true',
            Taints: 'node-role=cp:NoSchedule',
        });
        const pods = document.sections.find((s) => s.title === 'Pods')!;
        expect(pods.rows).toEqual([{ label: 'team-a/web-1', value: 'Running' }]);
    });

    it('calls a node with no role labels a worker', () => {
        const plain = { ...node, metadata: { name: 'node-2', labels: {} } } as V1Node;
        expect(describeMod.describeNode(plain, [], [], NOW).sections[0]!.rows[1]).toEqual({
            label: 'Roles',
            value: 'worker',
        });
    });
});

describe('reading a description', () => {
    it('describes the pod the screen named, with only its own events', async () => {
        core.listNamespacedEvent.mockResolvedValue({
            items: [event('BackOff', 60), { ...event('Other', 30), involvedObject: { uid: 'someone-else' } }],
        });
        const document = await describeMod.describeObject({ kind: 'Pod', name: 'web-1', namespace: 'team-a' });
        expect(document.sections[4]!.rows).toHaveLength(1);
        expect(core.readNamespacedPod).toHaveBeenCalledWith({ name: 'web-1', namespace: 'team-a' });
    });

    it('refuses a pod with no namespace to look in, and reports one that is gone', async () => {
        client.getActiveNamespace.mockReturnValue(null);
        await expect(describeMod.describeObject({ kind: 'Pod', name: 'web-1' })).rejects.toMatchObject({
            kind: 'invalid',
        });
        client.getActiveNamespace.mockReturnValue('team-a');
        core.readNamespacedPod.mockRejectedValue(new ApiException(404, 'gone', null, {}));
        await expect(
            describeMod.describeObject({ kind: 'Pod', name: 'ghost', namespace: 'team-a' }),
        ).rejects.toMatchObject({ kind: 'notFound' });
    });

    it('describes a node by a direct read, listing only the pods scheduled on it', async () => {
        core.readNode.mockImplementation(async ({ name }: { name: string }) => {
            if (name === 'node-1') return { metadata: { name: 'node-1', uid: 'n1' }, status: {} };
            throw new ApiException(404, 'not found', {}, {});
        });
        await expect(describeMod.describeObject({ kind: 'Node', name: 'node-1' })).resolves.toMatchObject({
            kind: 'Node',
            namespace: null,
        });
        expect(core.readNode).toHaveBeenCalledWith({ name: 'node-1' });
        expect(core.listPodForAllNamespaces).toHaveBeenCalledWith({ fieldSelector: 'spec.nodeName=node-1' });
        expect(core.listNode).not.toHaveBeenCalled();
        await expect(describeMod.describeObject({ kind: 'Node', name: 'ghost' })).rejects.toMatchObject({
            kind: 'notFound',
        });
        await expect(describeMod.describeObject({ kind: 'Node', name: 'a,b=c' })).rejects.toMatchObject({
            kind: 'invalid',
        });
        expect(core.readNode).not.toHaveBeenCalledWith({ name: 'a,b=c' });
    });

    it("shows the kubelet's node events, which name the node rather than carry its uid", async () => {
        core.readNode.mockResolvedValue({ metadata: { name: 'node-1', uid: 'n1' }, status: {} });
        core.listPodForAllNamespaces.mockResolvedValue({ items: [] });
        core.listEventForAllNamespaces.mockResolvedValue({
            items: [
                { ...event('NodeNotReady', 60), involvedObject: { kind: 'Node', name: 'node-1', uid: 'node-1' } },
                { ...event('Rebooted', 30), involvedObject: { kind: 'Node', name: 'node-1' } },
                { ...event('Other', 20), involvedObject: { kind: 'Node', name: 'node-2', uid: 'node-2' } },
                { ...event('Pulled', 10), involvedObject: { kind: 'Pod', name: 'node-1', uid: 'n1' } },
            ],
        });
        const document = await describeMod.describeObject({ kind: 'Node', name: 'node-1' });
        const events = document.sections.find((s) => s.title === 'Events')!;
        expect(events.rows.map((r) => r.label)).toEqual(['Warning Rebooted', 'Warning NodeNotReady']);
        expect(core.listEventForAllNamespaces).toHaveBeenCalledWith({
            fieldSelector: 'involvedObject.kind=Node,involvedObject.name=node-1',
        });
    });
});

describe('describeToText', () => {
    it('prints sections, aligned rows and indented blocks', () => {
        const text = describeToText(describeMod.describePod(pod(), [event('BackOff', 60)], NOW));
        expect(text).toContain('Overview:');
        expect(text).toMatch(/ {2}Node: +node-1/);
        expect(text).toContain('  web:');
        expect(text).toMatch(/ {4}Image: +nginx:1\.27/);
        expect(text.endsWith('\n')).toBe(true);
    });
});
