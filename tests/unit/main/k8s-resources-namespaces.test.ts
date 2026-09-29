import { ApiException, type V1Namespace, type V1Pod } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = {
    readNamespace: vi.fn(),
    listNamespacedPod: vi.fn(),
    listNamespacedService: vi.fn(),
    listNamespacedConfigMap: vi.fn(),
    listNamespacedSecret: vi.fn(),
    listNamespacedPersistentVolumeClaim: vi.fn(),
    listNamespacedResourceQuota: vi.fn(),
    listNamespacedLimitRange: vi.fn(),
};
const apps = {
    listNamespacedDeployment: vi.fn(),
    listNamespacedStatefulSet: vi.fn(),
    listNamespacedDaemonSet: vi.fn(),
};
const client = {
    apis: () => ({ core, apps }),
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
const sampler = { podUsage: vi.fn(() => ({ cpu: 5, mem: 10 })) };
vi.mock('../../../src/main/k8s/sampler.js', () => sampler);

const namespaces = await import('../../../src/main/k8s/resources/namespaces.js');

const pod = (name: string, requests?: { cpu?: string; memory?: string }): V1Pod => ({
    metadata: { name, namespace: 'team-a' },
    spec: { containers: [{ name: 'app', resources: requests ? { requests } : undefined }] },
});

describe('namespace transforms', () => {
    it('reports a namespace on its way out, which accepts no new object', () => {
        expect(namespaces.namespacePhase({ status: { phase: 'Terminating' } })).toBe('Terminating');
        expect(namespaces.namespacePhase({ status: { phase: 'Active' } })).toBe('Active');
        expect(namespaces.namespacePhase({})).toBe('Active');
    });

    it('sums what the pods asked for and what they use', () => {
        const pods = [pod('a', { cpu: '250m', memory: '128Mi' }), pod('b', { cpu: '1', memory: '1Gi' }), pod('c')];
        expect(namespaces.podRequests(pods)).toEqual({ cpu: 1250, mem: 1152 });
        // Usage comes from the sampler's latest read, so a list and a detail cannot disagree.
        expect(namespaces.podUsageTotal(pods)).toEqual({ cpu: 15, mem: 30 });
    });

    it('ignores a pod that declares no requests and one with no containers at all', () => {
        expect(namespaces.podRequests([pod('bare'), { metadata: { name: 'empty' } }])).toEqual({ cpu: 0, mem: 0 });
        expect(
            namespaces.podRequests([{ metadata: {}, spec: { containers: [{ name: 'c', resources: {} }] } }]),
        ).toEqual({ cpu: 0, mem: 0 });
    });

    it('leaves finished pods out of the requests, as the scheduler and quotas do', () => {
        const finished = (name: string, phase: string): V1Pod => ({
            ...pod(name, { cpu: '2', memory: '2Gi' }),
            status: { phase },
        });
        const running = { ...pod('live', { cpu: '250m', memory: '128Mi' }), status: { phase: 'Running' } };
        const pending = { ...pod('queued', { cpu: '100m', memory: '64Mi' }), status: { phase: 'Pending' } };
        expect(
            namespaces.podRequests([running, pending, finished('done', 'Succeeded'), finished('crashed', 'Failed')]),
        ).toEqual({ cpu: 350, mem: 192 });
    });

    it('counts nothing used for pods the sampler has no sample for', () => {
        sampler.podUsage.mockReturnValueOnce(undefined as never);
        expect(namespaces.podUsageTotal([pod('a')])).toEqual({ cpu: 0, mem: 0 });
        // A pod the API returned without metadata is still asked about, under empty names.
        expect(namespaces.podUsageTotal([{}])).toEqual({ cpu: 5, mem: 10 });
    });
});

describe('getNamespaceDetail', () => {
    beforeEach(() => {
        for (const api of [core, apps]) for (const fn of Object.values(api)) fn.mockReset();
        sampler.podUsage.mockReturnValue({ cpu: 5, mem: 10 });
        core.readNamespace.mockResolvedValue({
            metadata: { name: 'team-a', labels: { tier: 'app' } },
            status: { phase: 'Active' },
        } satisfies V1Namespace);
        core.listNamespacedPod.mockResolvedValue({ items: [pod('a', { cpu: '250m', memory: '128Mi' })] });
        core.listNamespacedService.mockResolvedValue({ items: [{}] });
        core.listNamespacedConfigMap.mockResolvedValue({ items: [{}, {}] });
        core.listNamespacedSecret.mockResolvedValue({ items: [] });
        core.listNamespacedPersistentVolumeClaim.mockResolvedValue({ items: [{}] });
        core.listNamespacedResourceQuota.mockResolvedValue({
            items: [
                { metadata: { name: 'q', namespace: 'team-a' }, status: { hard: { pods: '10' }, used: { pods: '3' } } },
            ],
        });
        core.listNamespacedLimitRange.mockResolvedValue({
            items: [
                {
                    metadata: { name: 'l', namespace: 'team-a' },
                    spec: { limits: [{ type: 'Container', max: { cpu: '2' } }] },
                },
            ],
        });
        apps.listNamespacedDeployment.mockResolvedValue({ items: [{}] });
        apps.listNamespacedStatefulSet.mockResolvedValue({ items: [] });
        apps.listNamespacedDaemonSet.mockResolvedValue({ items: [] });
    });

    it('rolls up what lives in the namespace, what it is allowed and what it uses', async () => {
        const detail = await namespaces.getNamespaceDetail('team-a');
        expect(detail).toMatchObject({
            name: 'team-a',
            phase: 'Active',
            labels: [['tier', 'app']],
            cpuUsed: 5,
            memUsed: 10,
            cpuRequested: 250,
            memRequested: 128,
        });
        // Every count carries the list screen for its kind, so it is a way in rather than a number.
        expect(detail?.counts).toEqual(
            expect.arrayContaining([
                { kind: 'Pod', count: 1, listPath: '/workloads/pods' },
                { kind: 'ConfigMap', count: 2, listPath: '/workloads/configmaps' },
                { kind: 'Secret', count: 0, listPath: '/workloads/secrets' },
            ]),
        );
        expect(detail?.quotas).toMatchObject([{ resource: 'pods', used: '3', hard: '10' }]);
        expect(detail?.limits).toMatchObject([{ type: 'Container', resource: 'cpu', max: '2' }]);
    });

    it('answers null for a namespace that is not there, without listing anything in it', async () => {
        core.readNamespace.mockRejectedValue(new ApiException(404, 'gone', {}, {}));
        await expect(namespaces.getNamespaceDetail('gone')).resolves.toBeNull();
        expect(core.listNamespacedPod).not.toHaveBeenCalled();
    });

    it('classifies a refusal under its own channel', async () => {
        core.readNamespace.mockRejectedValue(new ApiException(403, 'x', { message: 'denied' }, {}));
        await expect(namespaces.getNamespaceDetail('team-a')).rejects.toMatchObject({
            kind: 'forbidden',
            op: 'namespaces.detail',
        });
    });
});
