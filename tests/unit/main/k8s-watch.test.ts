import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeInformer extends EventEmitter {
    constructor() {
        // One fake informer is shared by every watch a test starts; the listener count is expected.
        super({ captureRejections: false });
        this.setMaxListeners(0);
    }
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    /** The informer's cache, which a second subscriber is replayed from. */
    cache: unknown[] = [];
    list = vi.fn(() => this.cache);
}
let informer = new FakeInformer();
const makeInformer = vi.fn(() => informer);
vi.mock('../../../src/main/k8s/informer.js', () => ({ makeInformer }));

const listNamespacedPod = vi.fn(async () => ({ items: [] }));
const listPodForAllNamespaces = vi.fn(async () => ({ items: [] }));
const listNamespacedDeployment = vi.fn(async () => ({ items: [] }));
const listDeploymentForAllNamespaces = vi.fn(async () => ({ items: [] }));
const listNamespacedStatefulSet = vi.fn(async () => ({ items: [] }));
const listStatefulSetForAllNamespaces = vi.fn(async () => ({ items: [] }));
const listNamespacedDaemonSet = vi.fn(async () => ({ items: [] }));
const listAny = vi.fn(async () => ({ items: [] }));
const listNamespacedJob = vi.fn(async () => ({ items: [] }));
const listCronJobForAllNamespaces = vi.fn(async () => ({ items: [] }));
const listNamespacedHorizontalPodAutoscaler = vi.fn(async () => ({ items: [] }));
const listDaemonSetForAllNamespaces = vi.fn(async () => ({ items: [] }));
const client = {
    kubeConfig: () => ({ fake: true }),
    apis: () => ({
        core: {
            listPersistentVolume: listAny,
            listNamespacedPersistentVolumeClaim: listAny,
            listPersistentVolumeClaimForAllNamespaces: listAny,
            listNamespacedPod,
            listPodForAllNamespaces,
            listNamespacedConfigMap: listAny,
            listConfigMapForAllNamespaces: listAny,
            listNamespacedSecret: listAny,
            listSecretForAllNamespaces: listAny,
            listNamespacedService: listAny,
            listServiceForAllNamespaces: listAny,
            listNamespacedEndpoints: listAny,
            listEndpointsForAllNamespaces: listAny,
            listNamespacedServiceAccount: listAny,
            listServiceAccountForAllNamespaces: listAny,
            listNamespacedReplicationController: listAny,
            listReplicationControllerForAllNamespaces: listAny,
        },
        apps: {
            listNamespacedDeployment,
            listDeploymentForAllNamespaces,
            listNamespacedStatefulSet,
            listStatefulSetForAllNamespaces,
            listNamespacedDaemonSet,
            listDaemonSetForAllNamespaces,
            listNamespacedReplicaSet: listAny,
            listReplicaSetForAllNamespaces: listAny,
        },
        batch: {
            listNamespacedJob,
            listJobForAllNamespaces: listAny,
            listNamespacedCronJob: listAny,
            listCronJobForAllNamespaces,
        },
        hpa: {
            listNamespacedHorizontalPodAutoscaler,
            listHorizontalPodAutoscalerForAllNamespaces: listAny,
        },
        storage: {
            listStorageClass: listAny,
            listCSIDriver: listAny,
            listCSINode: listAny,
            listNamespacedCSIStorageCapacity: listAny,
            listCSIStorageCapacityForAllNamespaces: listAny,
        },
        runtime: { listRuntimeClass: listAny },
        admission: {
            listMutatingWebhookConfiguration: listAny,
            listValidatingWebhookConfiguration: listAny,
            listValidatingAdmissionPolicy: listAny,
        },
        apiregistration: { listAPIService: listAny },
        flowcontrol: { listFlowSchema: listAny },
        policy: {
            listNamespacedPodDisruptionBudget: listAny,
            listPodDisruptionBudgetForAllNamespaces: listAny,
        },
        scheduling: { listPriorityClass: listAny },
        coordination: { listNamespacedLease: listAny, listLeaseForAllNamespaces: listAny },
        apiextensions: { listCustomResourceDefinition: listAny },
        rbac: {
            listNamespacedRole: listAny,
            listRoleForAllNamespaces: listAny,
            listNamespacedRoleBinding: listAny,
            listRoleBindingForAllNamespaces: listAny,
            listClusterRole: listAny,
            listClusterRoleBinding: listAny,
        },
        net: {
            listNamespacedIngress: listAny,
            listIngressForAllNamespaces: listAny,
            listNamespacedNetworkPolicy: listAny,
            listNetworkPolicyForAllNamespaces: listAny,
            listIngressClass: listAny,
        },
    }),
    resolveNamespace: (explicit?: string) => explicit ?? 'team-a',
};
vi.mock('../../../src/main/k8s/client.js', () => client);
const sampler = {
    ensureSampler: vi.fn(),
    containerUsage: vi.fn(() => undefined),
    podUsage: vi.fn(() => ({ cpu: 7, mem: 9 })),
};
vi.mock('../../../src/main/k8s/sampler.js', () => sampler);

const { startResourceWatch, WATCH_RETRY_MS, stopAllInformers, openInformerCount } =
    await import('../../../src/main/k8s/watch.js');

const pod = (name: string) => ({
    metadata: { name, namespace: 'team-a' },
    spec: { containers: [] },
    status: { phase: 'Running' },
});

describe('startResourceWatch', () => {
    beforeEach(() => {
        informer = new FakeInformer();
        makeInformer.mockClear();
        vi.useFakeTimers();
    });
    afterEach(() => {
        // Informers outlive one stream on purpose, so a test has to leave none behind.
        stopAllInformers();
        vi.useRealTimers();
    });

    it('opens one informer for two screens watching the same list, and replays the cache to the second', async () => {
        informer.cache = [{ metadata: { name: 'web-1', namespace: 'team-a' }, spec: {}, status: {} }];
        const first = vi.fn();
        const second = vi.fn();
        const a = await startResourceWatch({ kind: 'Pod', namespace: 'team-a' }, first);
        const b = await startResourceWatch({ kind: 'Pod', namespace: 'team-a' }, second);

        expect(makeInformer).toHaveBeenCalledTimes(1);
        expect(openInformerCount()).toBe(1);
        expect(informer.start).toHaveBeenCalledTimes(1);
        // The second screen is caught up from the cache rather than waiting for a fresh list.
        expect(second).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'data', data: expect.objectContaining({ type: 'added' }) }),
        );
        expect(first).not.toHaveBeenCalled();

        // Both hear every later event.
        informer.emit('update', { metadata: { name: 'web-1', namespace: 'team-a' }, spec: {}, status: {} });
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(2);

        // The informer lives until the last screen goes.
        a.stop();
        expect(informer.stop).not.toHaveBeenCalled();
        b.stop();
        expect(informer.stop).toHaveBeenCalledTimes(1);
        expect(openInformerCount()).toBe(0);
    });

    it('keeps separate informers for different kinds and namespaces', async () => {
        await startResourceWatch({ kind: 'Pod', namespace: 'team-a' }, vi.fn());
        await startResourceWatch({ kind: 'Pod', namespace: 'kube-system' }, vi.fn());
        await startResourceWatch({ kind: 'Deployment', namespace: 'team-a' }, vi.fn());
        expect(openInformerCount()).toBe(3);
    });

    it('stops every informer when the connection goes', async () => {
        await startResourceWatch({ kind: 'Pod', namespace: 'team-a' }, vi.fn());
        await startResourceWatch({ kind: 'Deployment', namespace: 'team-a' }, vi.fn());
        stopAllInformers();
        expect(openInformerCount()).toBe(0);
        expect(informer.stop).toHaveBeenCalledTimes(2);
    });

    it('refuses a malformed namespace before it can reach the watch path', async () => {
        for (const namespace of ['', 'a/pods/../deployments', 'Team-A', 'a?watch=false']) {
            await expect(startResourceWatch({ kind: 'Pod', namespace }, vi.fn())).rejects.toThrow();
        }
        expect(makeInformer).not.toHaveBeenCalled();
    });

    it('watches the resolved namespace path with the matching list function', async () => {
        const send = vi.fn();
        await startResourceWatch({ kind: 'Pod', namespace: 'explicit' }, send);
        expect(makeInformer).toHaveBeenCalledWith(
            { fake: true },
            '/api/v1/namespaces/explicit/pods',
            expect.any(Function),
        );
        await (makeInformer.mock.calls[0] as unknown[])[2]!();
        expect(listNamespacedPod).toHaveBeenCalledWith({ namespace: 'explicit' });
        expect(informer.start).toHaveBeenCalledOnce();
    });

    it('falls back to the active namespace, or all namespaces when none is active', async () => {
        await startResourceWatch({ kind: 'Pod' }, vi.fn());
        expect(makeInformer).toHaveBeenLastCalledWith(
            expect.anything(),
            '/api/v1/namespaces/team-a/pods',
            expect.any(Function),
        );
        client.resolveNamespace = () => undefined;
        await startResourceWatch({ kind: 'Pod' }, vi.fn());
        expect(makeInformer).toHaveBeenLastCalledWith(expect.anything(), '/api/v1/pods', expect.any(Function));
        await (makeInformer.mock.calls[1] as unknown[])[2]!();
        expect(listPodForAllNamespaces).toHaveBeenCalled();
        client.resolveNamespace = (explicit?: string) => explicit ?? 'team-a';
    });

    it('translates informer events into typed watch events with the row transform', async () => {
        const send = vi.fn();
        await startResourceWatch({ kind: 'Pod' }, send);
        informer.emit('add', pod('web-1'));
        informer.emit('update', pod('web-1'));
        informer.emit('delete', pod('web-1'));
        expect(send.mock.calls.map((c) => c[0].data.type)).toEqual(['added', 'modified', 'deleted']);
        expect(send.mock.calls[0]![0]).toMatchObject({
            type: 'data',
            data: { kind: 'Pod', item: { name: 'web-1', namespace: 'team-a', status: 'Running' } },
        });
    });

    it('reports an informer error and restarts after the retry delay while active', async () => {
        const send = vi.fn();
        const { stop } = await startResourceWatch({ kind: 'Pod' }, send);
        informer.emit('error', new Error('watch closed'));
        expect(send).toHaveBeenCalledWith({ type: 'error', message: 'watch closed' });
        expect(informer.start).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(WATCH_RETRY_MS);
        expect(informer.start).toHaveBeenCalledTimes(2);
        stop();
        informer.emit('error', 'later');
        expect(send).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(WATCH_RETRY_MS);
        expect(informer.start).toHaveBeenCalledTimes(2);
        expect(informer.stop).toHaveBeenCalledOnce();
    });

    it('reports a start that rejects and retries it, rather than leaving the rejection unhandled', async () => {
        informer.start.mockRejectedValueOnce(new Error('exec plugin aws failed')).mockRejectedValueOnce('again');
        const send = vi.fn();
        const { stop } = await startResourceWatch({ kind: 'Pod' }, send);
        expect(send).toHaveBeenCalledWith({ type: 'error', message: 'exec plugin aws failed' });

        // The retry rejects as well, and is reported and scheduled again.
        await vi.advanceTimersByTimeAsync(WATCH_RETRY_MS);
        expect(informer.start).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenLastCalledWith({ type: 'error', message: 'again' });
        await vi.advanceTimersByTimeAsync(WATCH_RETRY_MS);
        expect(informer.start).toHaveBeenCalledTimes(3);
        stop();
    });

    it('keeps retrying a first start that failed for a screen that arrives later', async () => {
        informer.start.mockRejectedValueOnce(new Error('token expired'));
        const first = await startResourceWatch({ kind: 'Pod', namespace: 'team-a' }, vi.fn());
        first.stop();
        // The failed screen went, so nothing of it is left to make the next screen "second".
        expect(openInformerCount()).toBe(0);

        informer.start.mockRejectedValueOnce(new Error('token expired'));
        const a = vi.fn();
        await startResourceWatch({ kind: 'Pod', namespace: 'team-a' }, a);
        const b = vi.fn();
        await startResourceWatch({ kind: 'Pod', namespace: 'team-a' }, b);
        expect(informer.start).toHaveBeenCalledTimes(2);
        // The second screen shares the failing informer, which is still retried for both.
        await vi.advanceTimersByTimeAsync(WATCH_RETRY_MS);
        expect(informer.start).toHaveBeenCalledTimes(3);
        expect(a).toHaveBeenCalledWith({ type: 'error', message: 'token expired' });
    });

    it('keeps one pending retry when a failure is reported twice', async () => {
        await startResourceWatch({ kind: 'Pod' }, vi.fn());
        informer.emit('error', new Error('one'));
        informer.emit('error', new Error('two'));
        await vi.advanceTimersByTimeAsync(WATCH_RETRY_MS);
        expect(informer.start).toHaveBeenCalledTimes(2);
    });

    it('stops emitting after stop and cancels a pending retry', async () => {
        const send = vi.fn();
        const { stop } = await startResourceWatch({ kind: 'Pod' }, send);
        informer.emit('error', new Error('x'));
        stop();
        await vi.advanceTimersByTimeAsync(WATCH_RETRY_MS);
        informer.emit('add', pod('late'));
        expect(informer.start).toHaveBeenCalledTimes(1);
        expect(send.mock.calls.filter((c) => c[0].type === 'data')).toHaveLength(0);
    });

    it('watches the workload kinds on their apps paths with their row transforms', async () => {
        const send = vi.fn();
        await startResourceWatch({ kind: 'Deployment', namespace: 'team-a' }, send);
        expect(makeInformer).toHaveBeenLastCalledWith(
            expect.anything(),
            '/apis/apps/v1/namespaces/team-a/deployments',
            expect.any(Function),
        );
        await (makeInformer.mock.calls[0] as unknown[])[2]!();
        expect(listNamespacedDeployment).toHaveBeenCalledWith({ namespace: 'team-a' });
        informer.emit('add', {
            metadata: { name: 'web', namespace: 'team-a' },
            spec: { replicas: 1 },
            status: { availableReplicas: 1 },
        });
        expect(send.mock.calls[0]![0]).toMatchObject({
            data: { kind: 'Deployment', type: 'added', item: { name: 'web', status: 'Healthy', ready: '0/1' } },
        });

        client.resolveNamespace = () => undefined;
        await startResourceWatch({ kind: 'DaemonSet' }, vi.fn());
        expect(makeInformer).toHaveBeenLastCalledWith(
            expect.anything(),
            '/apis/apps/v1/daemonsets',
            expect.any(Function),
        );
        await (makeInformer.mock.calls[1] as unknown[])[2]!();
        expect(listDaemonSetForAllNamespaces).toHaveBeenCalled();
        client.resolveNamespace = (explicit?: string) => explicit ?? 'team-a';
        await startResourceWatch({ kind: 'StatefulSet' }, vi.fn());
        expect(makeInformer).toHaveBeenLastCalledWith(
            expect.anything(),
            '/apis/apps/v1/namespaces/team-a/statefulsets',
            expect.any(Function),
        );
    });

    it('uses the namespaced or cluster-wide list for every workload kind', async () => {
        const listOf = async (index: number) =>
            (makeInformer.mock.calls[index] as unknown[])[2] as () => Promise<unknown>;
        await startResourceWatch({ kind: 'StatefulSet', namespace: 'team-a' }, vi.fn());
        await (
            await listOf(0)
        )();
        expect(listNamespacedStatefulSet).toHaveBeenCalledWith({ namespace: 'team-a' });
        await startResourceWatch({ kind: 'DaemonSet', namespace: 'team-a' }, vi.fn());
        await (
            await listOf(1)
        )();
        expect(listNamespacedDaemonSet).toHaveBeenCalledWith({ namespace: 'team-a' });
        client.resolveNamespace = () => undefined;
        await startResourceWatch({ kind: 'Deployment' }, vi.fn());
        await (
            await listOf(2)
        )();
        expect(listDeploymentForAllNamespaces).toHaveBeenCalled();
        await startResourceWatch({ kind: 'StatefulSet' }, vi.fn());
        await (
            await listOf(3)
        )();
        expect(listStatefulSetForAllNamespaces).toHaveBeenCalled();
        client.resolveNamespace = (explicit?: string) => explicit ?? 'team-a';

        const send = vi.fn();
        await startResourceWatch({ kind: 'StatefulSet' }, send);
        informer.emit('add', {
            metadata: { name: 'db', namespace: 'team-a' },
            spec: { replicas: 1, serviceName: 'db' },
        });
        expect(send.mock.calls[0]![0]).toMatchObject({
            data: { kind: 'StatefulSet', item: { name: 'db', service: 'db' } },
        });
        await startResourceWatch({ kind: 'DaemonSet' }, send);
        informer.emit('add', { metadata: { name: 'agent', namespace: 'team-a' }, status: { numberReady: 2 } });
        // Both watches share the fake informer, so the second emit reaches both listeners; the
        // DaemonSet's send is the last one.
        expect(send.mock.calls.at(-1)![0]).toMatchObject({
            data: { kind: 'DaemonSet', item: { name: 'agent', ready: 2 } },
        });
    });

    it('watches the batch and autoscaler kinds on their own API paths', async () => {
        const listOf = (index: number) => (makeInformer.mock.calls[index] as unknown[])[2] as () => Promise<unknown>;
        const send = vi.fn();
        await startResourceWatch({ kind: 'Job', namespace: 'team-a' }, send);
        expect(makeInformer).toHaveBeenLastCalledWith(
            expect.anything(),
            '/apis/batch/v1/namespaces/team-a/jobs',
            expect.any(Function),
        );
        await listOf(0)();
        expect(listNamespacedJob).toHaveBeenCalledWith({ namespace: 'team-a' });
        informer.emit('add', {
            metadata: { name: 'import', namespace: 'team-a' },
            status: { conditions: [{ type: 'Complete', status: 'True' }] },
        });
        expect(send.mock.calls.at(-1)![0]).toMatchObject({
            data: { kind: 'Job', type: 'added', item: { name: 'import', status: 'Complete' } },
        });

        client.resolveNamespace = () => undefined;
        await startResourceWatch({ kind: 'CronJob' }, vi.fn());
        expect(makeInformer).toHaveBeenLastCalledWith(
            expect.anything(),
            '/apis/batch/v1/cronjobs',
            expect.any(Function),
        );
        await listOf(1)();
        expect(listCronJobForAllNamespaces).toHaveBeenCalled();
        client.resolveNamespace = (explicit?: string) => explicit ?? 'team-a';

        await startResourceWatch({ kind: 'HorizontalPodAutoscaler' }, vi.fn());
        expect(makeInformer).toHaveBeenLastCalledWith(
            expect.anything(),
            '/apis/autoscaling/v2/namespaces/team-a/horizontalpodautoscalers',
            expect.any(Function),
        );
        await listOf(2)();
        expect(listNamespacedHorizontalPodAutoscaler).toHaveBeenCalledWith({ namespace: 'team-a' });
    });

    it('gives every registered kind a namespaced path, a cluster-wide path and a row transform', async () => {
        const { KINDS, kindInfo } = await import('../../../src/shared/k8s/registry.js');
        // VolumeSnapshot is polled: a cluster need not have its CRD, so it has no watch source.
        const watched = KINDS.filter((kind) => kind !== 'VolumeSnapshot');
        // roleRef is required on both binding kinds, so the shared fixture carries one.
        const object = {
            metadata: { name: 'x', namespace: 'team-a' },
            spec: {},
            status: {},
            roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'reader' },
        };
        for (const [index, kind] of watched.entries()) {
            const clusterScoped = kindInfo(kind).clusterScoped;
            const send = vi.fn();
            await startResourceWatch({ kind, namespace: 'team-a' }, send);
            const [, namespacedPath, list] = makeInformer.mock.calls[index * 2] as [
                unknown,
                string,
                () => Promise<unknown>,
            ];
            expect(clusterScoped ? true : namespacedPath.includes('/namespaces/team-a/')).toBe(true);
            await expect(list()).resolves.toEqual({ items: [] });
            informer.emit('add', object);
            expect(send.mock.calls.at(-1)![0]).toMatchObject({ data: { kind, type: 'added', item: { name: 'x' } } });

            client.resolveNamespace = () => undefined;
            await startResourceWatch({ kind }, vi.fn());
            const [, clusterPath, listAll] = makeInformer.mock.calls[index * 2 + 1] as [
                unknown,
                string,
                () => Promise<unknown>,
            ];
            expect(clusterPath).not.toContain('/namespaces/');
            await expect(listAll()).resolves.toEqual({ items: [] });
            client.resolveNamespace = (explicit?: string) => explicit ?? 'team-a';
        }
    });

    it('refuses to watch a kind that has no watch source', async () => {
        await expect(startResourceWatch({ kind: 'VolumeSnapshot' }, vi.fn())).rejects.toMatchObject({
            kind: 'invalid',
            op: 'resources.watch',
        });
        expect(makeInformer).not.toHaveBeenCalled();
    });

    it('rejects an invalid input before touching the cluster', async () => {
        await expect(startResourceWatch({ kind: 'Nope' }, vi.fn())).rejects.toThrow();
        expect(makeInformer).not.toHaveBeenCalled();
    });
});
