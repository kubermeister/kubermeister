import { ApiException, type V1Pod } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = { readNamespacedPod: vi.fn(), listNamespacedService: vi.fn() };
const net = { listNamespacedNetworkPolicy: vi.fn() };
const client = {
    apis: () => ({ core, net }),
    getActiveNamespace: vi.fn<() => string | null>(),
    resolveObjectNamespace: (explicit?: string) => explicit ?? client.getActiveNamespace(),
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

const related = await import('../../../src/main/k8s/resources/related.js');

const pod: V1Pod = {
    metadata: { name: 'web-1', namespace: 'team-a', labels: { app: 'web', tier: 'front' } },
    spec: {
        serviceAccountName: 'web-sa',
        imagePullSecrets: [{ name: 'registry' }],
        volumes: [
            { name: 'config', configMap: { name: 'app-config' } },
            { name: 'creds', secret: { secretName: 'app-secret' } },
            { name: 'data', persistentVolumeClaim: { claimName: 'data' } },
            { name: 'combined', projected: { sources: [{ configMap: { name: 'projected-config' } }] } },
        ],
        containers: [
            {
                name: 'web',
                envFrom: [{ configMapRef: { name: 'env-config' } }],
                env: [{ name: 'TOKEN', valueFrom: { secretKeyRef: { name: 'token', key: 't' } } }],
            },
        ],
    },
};

describe('selector matching', () => {
    it('covers a set of labels only when every entry matches', () => {
        expect(related.selectorCovers({ app: 'web' }, { app: 'web', tier: 'front' })).toBe(true);
        expect(related.selectorCovers({ app: 'web', tier: 'back' }, { app: 'web', tier: 'front' })).toBe(false);
        // An empty selector selects nothing here, as the API has it for a service.
        expect(related.selectorCovers({}, { app: 'web' })).toBe(false);
        expect(related.selectorCovers(undefined, { app: 'web' })).toBe(false);
    });

    it('reads a label selector as the API does, expressions included', () => {
        const labels = { app: 'web', tier: 'front' };
        // An empty label selector selects everything, and an absent one nothing.
        expect(related.labelSelectorSelects({}, labels)).toBe(true);
        expect(related.labelSelectorSelects({ matchLabels: {}, matchExpressions: [] }, labels)).toBe(true);
        expect(related.labelSelectorSelects(undefined, labels)).toBe(false);
        expect(related.labelSelectorSelects(null, labels)).toBe(false);
        expect(related.labelSelectorSelects({ matchLabels: { app: 'web' } }, labels)).toBe(true);
        expect(related.labelSelectorSelects({ matchLabels: { app: 'db' } }, labels)).toBe(false);
        const expression = (operator: string, key: string, values?: string[]) => ({
            matchExpressions: [{ key, operator, values }],
        });
        expect(related.labelSelectorSelects(expression('In', 'tier', ['front', 'back']), labels)).toBe(true);
        expect(related.labelSelectorSelects(expression('In', 'tier', ['back']), labels)).toBe(false);
        expect(related.labelSelectorSelects(expression('In', 'zone', ['a']), labels)).toBe(false);
        expect(related.labelSelectorSelects(expression('NotIn', 'tier', ['front']), labels)).toBe(false);
        expect(related.labelSelectorSelects(expression('NotIn', 'tier', ['back']), labels)).toBe(true);
        // NotIn also selects a pod without the key at all.
        expect(related.labelSelectorSelects(expression('NotIn', 'zone', ['a']), labels)).toBe(true);
        expect(related.labelSelectorSelects(expression('Exists', 'tier'), labels)).toBe(true);
        expect(related.labelSelectorSelects(expression('Exists', 'zone'), labels)).toBe(false);
        expect(related.labelSelectorSelects(expression('DoesNotExist', 'zone'), labels)).toBe(true);
        expect(related.labelSelectorSelects(expression('DoesNotExist', 'tier'), labels)).toBe(false);
        // An operator the API does not know is refused there, so it is no reason to link anything.
        expect(related.labelSelectorSelects(expression('Like', 'tier', ['front']), labels)).toBe(false);
        // Labels and expressions must both hold.
        expect(
            related.labelSelectorSelects(
                {
                    matchLabels: { app: 'web' },
                    matchExpressions: [{ key: 'tier', operator: 'NotIn', values: ['front'] }],
                },
                labels,
            ),
        ).toBe(false);
    });
});

describe('what a pod spec names', () => {
    it('finds every reference and says how the pod names it', () => {
        const links = related.specReferences(pod.spec, 'team-a');
        expect(links).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'ConfigMap', name: 'app-config', why: 'mounted as volume “config”' }),
                expect.objectContaining({ kind: 'Secret', name: 'app-secret', why: 'mounted as volume “creds”' }),
                expect.objectContaining({ kind: 'PersistentVolumeClaim', name: 'data' }),
                expect.objectContaining({
                    kind: 'ConfigMap',
                    name: 'projected-config',
                    why: 'projected into “combined”',
                }),
                expect.objectContaining({ kind: 'ConfigMap', name: 'env-config', why: 'envFrom in web' }),
                expect.objectContaining({ kind: 'Secret', name: 'token', why: 'env TOKEN in web' }),
                expect.objectContaining({ kind: 'Secret', name: 'registry', why: 'image pull secret' }),
                expect.objectContaining({ kind: 'ServiceAccount', name: 'web-sa', why: 'runs as' }),
            ]),
        );
        // Each link carries the screen for its kind, so a relation is a way in.
        expect(links.find((one) => one.name === 'app-config')?.path).toBe('/workloads/configmaps/team-a/app-config');
    });

    it('skips a reference with no name and an init container is read like any other', () => {
        const links = related.specReferences(
            {
                volumes: [
                    { name: 'empty', configMap: {} },
                    { name: 'plain', emptyDir: {} },
                ],
                initContainers: [
                    { name: 'setup', env: [{ name: 'X', valueFrom: { configMapKeyRef: { name: 'seed', key: 'k' } } }] },
                ],
                containers: [],
            },
            'team-a',
        );
        expect(links.map((one) => one.name)).toEqual(['seed']);
        expect(links[0]!.why).toBe('env X in setup');
    });

    it('names nothing for a spec that references nothing, and never twice for one reason', () => {
        expect(related.specReferences(undefined, 'team-a')).toEqual([]);
        const twice = related.specReferences(
            {
                containers: [
                    { name: 'a', envFrom: [{ configMapRef: { name: 'shared' } }] },
                    { name: 'b', envFrom: [{ configMapRef: { name: 'shared' } }] },
                ],
            },
            'team-a',
        );
        // The same config map through two containers is two relations, each with its own reason.
        expect(twice.map((one) => one.why)).toEqual(['envFrom in a', 'envFrom in b']);
    });
});

describe('getRelated', () => {
    beforeEach(() => {
        for (const api of [core, net]) for (const fn of Object.values(api)) fn.mockReset();
        client.getActiveNamespace.mockReturnValue('team-a');
        core.readNamespacedPod.mockResolvedValue(pod);
        core.listNamespacedService.mockResolvedValue({
            items: [
                { metadata: { name: 'web' }, spec: { selector: { app: 'web' } } },
                { metadata: { name: 'other' }, spec: { selector: { app: 'db' } } },
            ],
        });
        net.listNamespacedNetworkPolicy.mockResolvedValue({
            items: [{ metadata: { name: 'deny-all' }, spec: { podSelector: { matchLabels: { app: 'web' } } } }],
        });
    });

    it('groups what routes to the pod, what it reads and what it runs as', async () => {
        const groups = await related.getRelated('Pod', 'web-1', 'team-a');
        expect(groups.map((group) => group.label)).toEqual(['Traffic', 'Configuration', 'Storage', 'Access']);
        const traffic = groups[0]!.items;
        // Only the service whose selector actually covers the pod's labels is a relation.
        expect(traffic.map((one) => one.name)).toEqual(['web', 'deny-all']);
        expect(traffic[0]!.why).toBe('selects these pods');
    });

    it('links a policy selecting every pod and never one whose expressions exclude the pod', async () => {
        net.listNamespacedNetworkPolicy.mockResolvedValue({
            items: [
                { metadata: { name: 'default-deny' }, spec: { podSelector: {} } },
                { metadata: { name: 'no-selector' }, spec: {} },
                {
                    metadata: { name: 'not-front' },
                    spec: {
                        podSelector: {
                            matchLabels: { app: 'web' },
                            matchExpressions: [{ key: 'tier', operator: 'NotIn', values: ['front'] }],
                        },
                    },
                },
                {
                    metadata: { name: 'front-only' },
                    spec: { podSelector: { matchExpressions: [{ key: 'tier', operator: 'In', values: ['front'] }] } },
                },
            ],
        });
        const groups = await related.getRelated('Pod', 'web-1', 'team-a');
        const policies = groups[0]!.items.filter((one) => one.kind === 'NetworkPolicy');
        // A policy with no pod selector at all selects every pod too: the field is required and `{}` is its empty form.
        expect(policies.map((one) => one.name)).toEqual(['default-deny', 'no-selector', 'front-only']);
    });

    it('answers nothing for a kind it cannot explain yet, and refuses without a namespace', async () => {
        await expect(related.getRelated('ConfigMap', 'app-config', 'team-a')).resolves.toEqual([]);
        client.getActiveNamespace.mockReturnValue(null);
        await expect(related.getRelated('Pod', 'web-1')).rejects.toMatchObject({
            kind: 'invalid',
            op: 'resources.related',
        });
    });

    it('reports a missing pod rather than an empty set of relations', async () => {
        core.readNamespacedPod.mockImplementation(() => Promise.reject(new ApiException(404, 'gone', {}, {})));
        await expect(related.getRelated('Pod', 'gone', 'team-a')).rejects.toMatchObject({ kind: 'notFound' });
    });
});
