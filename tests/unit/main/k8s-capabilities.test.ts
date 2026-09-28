import { ApiException } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { K8sError } from '../../../src/main/k8s/errors';

const getCode = vi.fn();
vi.mock('../../../src/main/k8s/client.js', () => ({ apis: () => ({ version: { getCode } }) }));

const clusterGet = vi.fn();
vi.mock('../../../src/main/k8s/cluster-get.js', () => ({ clusterGet }));

const { apiVersionSet, clusterCapabilities } = await import('../../../src/main/k8s/capabilities.js');

const CORE = { kind: 'APIVersions', versions: ['v1'] };
const GROUPS = {
    kind: 'APIGroupList',
    groups: [
        { name: 'apps', versions: [{ groupVersion: 'apps/v1', version: 'v1' }] },
        {
            name: 'autoscaling',
            versions: [
                { groupVersion: 'autoscaling/v2', version: 'v2' },
                { groupVersion: 'autoscaling/v1', version: 'v1' },
            ],
        },
        { name: 'metrics.k8s.io', versions: [{ groupVersion: 'metrics.k8s.io/v1beta1', version: 'v1beta1' }] },
    ],
};
const resources = (groupVersion: string, kinds: [string, string][]) => ({
    kind: 'APIResourceList',
    groupVersion,
    resources: kinds.map(([name, kind]) => ({ name, kind, namespaced: true })),
});

const ANSWERS: Record<string, unknown> = {
    '/api': CORE,
    '/apis': GROUPS,
    '/api/v1': resources('v1', [
        ['pods', 'Pod'],
        ['pods/log', 'Pod'],
        ['services', 'Service'],
    ]),
    '/apis/apps/v1': resources('apps/v1', [
        ['deployments', 'Deployment'],
        ['deployments/scale', 'Scale'],
    ]),
    '/apis/autoscaling/v2': resources('autoscaling/v2', [['horizontalpodautoscalers', 'HorizontalPodAutoscaler']]),
    '/apis/autoscaling/v1': resources('autoscaling/v1', [['horizontalpodautoscalers', 'HorizontalPodAutoscaler']]),
};

beforeEach(() => {
    getCode.mockReset();
    getCode.mockResolvedValue({ gitVersion: 'v1.31.2+k3s1', major: '1', minor: '31' });
    clusterGet.mockReset();
    clusterGet.mockImplementation((url: string) => {
        if (url === '/apis/metrics.k8s.io/v1beta1') {
            return Promise.reject(new ApiException(503, 'service unavailable', undefined, {}));
        }
        return Promise.resolve(ANSWERS[url] ?? null);
    });
});

describe('apiVersionSet', () => {
    it('lists every group-version and every group-version/Kind, as Helm’s own discovery does', () => {
        const set = apiVersionSet(['v1', 'apps/v1'], [ANSWERS['/api/v1'], ANSWERS['/apis/apps/v1']]);
        expect(set).toEqual(['apps/v1', 'apps/v1/Deployment', 'v1', 'v1/Pod', 'v1/Service']);
    });

    it('keeps a group-version whose resources could not be read, and ignores answers of the wrong shape', () => {
        expect(apiVersionSet(['v1', 'x.io/v1'], [null, { resources: 'nope' }])).toEqual(['v1', 'x.io/v1']);
        expect(apiVersionSet(['v1'], [{ resources: [{ name: 'pods' }, null, { kind: 'Pod' }] }])).toEqual(['v1']);
    });
});

describe('clusterCapabilities', () => {
    it('answers the server version and what discovery serves', async () => {
        const capabilities = await clusterCapabilities();
        expect(capabilities.kubeVersion).toBe('v1.31.2+k3s1');
        expect(capabilities.apiVersions).toEqual([
            'apps/v1',
            'apps/v1/Deployment',
            'autoscaling/v1',
            'autoscaling/v1/HorizontalPodAutoscaler',
            'autoscaling/v2',
            'autoscaling/v2/HorizontalPodAutoscaler',
            'metrics.k8s.io/v1beta1',
            'v1',
            'v1/Pod',
            'v1/Service',
        ]);
        expect(clusterGet).toHaveBeenCalledWith('/apis/apps/v1', 'charts.capabilities');
    });

    it('fails when the version or the group listing cannot be read', async () => {
        getCode.mockRejectedValueOnce(new ApiException(403, 'forbidden', undefined, {}));
        await expect(clusterCapabilities()).rejects.toMatchObject({ kind: 'forbidden', op: 'charts.capabilities' });

        clusterGet.mockImplementation((url: string) =>
            url === '/apis'
                ? Promise.reject(new ApiException(401, 'unauthorized', undefined, {}))
                : Promise.resolve(CORE),
        );
        const failure = clusterCapabilities();
        await expect(failure).rejects.toBeInstanceOf(K8sError);
        await expect(failure).rejects.toMatchObject({ kind: 'unauthorized' });
    });

    it('answers no core versions when the server lists none', async () => {
        clusterGet.mockImplementation((url: string) => Promise.resolve(url === '/apis' ? { groups: [] } : null));
        await expect(clusterCapabilities()).resolves.toEqual({ kubeVersion: 'v1.31.2+k3s1', apiVersions: [] });
    });
});
