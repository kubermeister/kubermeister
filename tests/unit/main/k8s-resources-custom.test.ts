import { ApiException, type V1CustomResourceDefinition } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiextensions = { readCustomResourceDefinition: vi.fn() };
const customObjects = {
    listNamespacedCustomObject: vi.fn(),
    listCustomObjectForAllNamespaces: vi.fn(),
    listClusterCustomObject: vi.fn(),
    getNamespacedCustomObject: vi.fn(),
    getClusterCustomObject: vi.fn(),
};
const client = {
    apis: () => ({ apiextensions, customObjects }),
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

const custom = await import('../../../src/main/k8s/resources/custom.js');

const NOW = Date.parse('2026-09-16T12:00:00Z');
const HOUR = 3600 * 1000;

const definition = (overrides: Partial<V1CustomResourceDefinition['spec']> = {}): V1CustomResourceDefinition => ({
    metadata: { name: 'widgets.example.com' },
    spec: {
        group: 'example.com',
        scope: 'Namespaced',
        names: { plural: 'widgets', singular: 'widget', kind: 'Widget' },
        versions: [
            {
                name: 'v1alpha1',
                served: true,
                storage: false,
                additionalPrinterColumns: [{ name: 'Old', type: 'string', jsonPath: '.spec.old' }],
            },
            {
                name: 'v1',
                served: true,
                storage: true,
                additionalPrinterColumns: [
                    { name: 'Size', type: 'string', jsonPath: '.spec.size' },
                    { name: 'Ready', type: 'boolean', jsonPath: '.status.ready' },
                    { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
                ],
            },
        ],
        ...overrides,
    },
});

const widget = {
    metadata: { name: 'left', namespace: 'team-a', creationTimestamp: new Date(NOW - HOUR), labels: { a: 'b' } },
    spec: { size: 'large' },
    status: { ready: true },
};

describe('reading a definition', () => {
    it('takes the storage version, falling back to any served one', () => {
        expect(custom.readableVersion(definition())).toBe('v1');
        const served = definition({
            versions: [{ name: 'v2beta1', served: true, storage: false }],
        });
        expect(custom.readableVersion(served)).toBe('v2beta1');
        expect(custom.readableVersion(definition({ versions: [] }))).toBeUndefined();
    });

    it('passes over a storage version that is no longer served', () => {
        // Mid-migration the storage version can be unserved, and every read of it answers 404.
        const migrating = definition({
            versions: [
                { name: 'v1alpha1', served: false, storage: true },
                { name: 'v1', served: true, storage: false },
            ],
        });
        expect(custom.readableVersion(migrating)).toBe('v1');
        const unserved = definition({ versions: [{ name: 'v1alpha1', served: false, storage: true }] });
        expect(custom.readableVersion(unserved)).toBeUndefined();
    });

    it('takes that version’s printer columns and drops the one the app already shows', () => {
        // Age is the last column of every list here; the definition's own copy would just repeat it.
        expect(custom.printerColumns(definition(), 'v1')).toEqual([
            { name: 'Size', type: 'string', jsonPath: '.spec.size' },
            { name: 'Ready', type: 'boolean', jsonPath: '.status.ready' },
        ]);
        expect(custom.printerColumns(definition(), 'v1alpha1')).toHaveLength(1);
        expect(custom.printerColumns(definition(), 'nope')).toEqual([]);
    });
});

describe('the printer-column subset of JSONPath', () => {
    it('walks dotted keys, quoted keys and array indexes', () => {
        const object = {
            spec: { size: 'large', ports: [{ port: 80 }] },
            metadata: { labels: { 'app.kubernetes.io/name': 'widget' } },
        };
        expect(custom.valueAt(object, '.spec.size')).toBe('large');
        expect(custom.valueAt(object, '$.spec.size')).toBe('large');
        expect(custom.valueAt(object, '.spec.ports[0].port')).toBe(80);
        expect(custom.valueAt(object, `.metadata.labels['app.kubernetes.io/name']`)).toBe('widget');
    });

    it('answers nothing rather than half-evaluating what it cannot do', () => {
        const object = { spec: { ports: [{ port: 80 }] } };
        // Filters, wildcards and unions are richer than this reader; a wrong value would look right.
        expect(custom.valueAt(object, '.spec.ports[*].port')).toBeUndefined();
        expect(custom.valueAt(object, '.spec.ports[?(@.port>80)]')).toBeUndefined();
        expect(custom.valueAt(object, '.spec.missing.deeper')).toBeUndefined();
        expect(custom.valueAt(object, '.spec.ports[9].port')).toBeUndefined();
        expect(custom.valueAt(object, '.spec.size.length')).toBeUndefined();
        // An unterminated or non-numeric bracket is refused rather than guessed at.
        expect(custom.pathSteps(".spec['unclosed")).toBeNull();
        expect(custom.pathSteps('.spec[1:2]')).toBeNull();
        expect(custom.pathSteps('.spec.ports[0].port')).toEqual(['spec', 'ports', '0', 'port']);
    });

    it('renders cells the way kubectl does', () => {
        expect(custom.renderCell(undefined, 'string')).toBe('—');
        expect(custom.renderCell(null, 'string')).toBe('—');
        expect(custom.renderCell(true, 'boolean')).toBe('true');
        expect(custom.renderCell(7, 'integer')).toBe('7');
        expect(custom.renderCell(new Date(NOW - HOUR).toISOString(), 'date', NOW)).toBe('1h');
        expect(custom.renderCell({ a: 1 }, 'string')).toBe('{"a":1}');
    });

    it('builds a row and a detail from an instance', () => {
        const columns = custom.printerColumns(definition(), 'v1');
        expect(custom.toCustomResourceRow(widget, columns, NOW)).toEqual({
            name: 'left',
            namespace: 'team-a',
            age: '1h',
            cells: { '.spec.size': 'large', '.status.ready': 'true' },
        });
        expect(custom.toCustomResourceDetail(widget, columns, NOW)).toMatchObject({ labels: [['a', 'b']] });
    });
});

describe('instance readers', () => {
    beforeEach(() => {
        apiextensions.readCustomResourceDefinition.mockReset();
        for (const fn of Object.values(customObjects)) fn.mockReset();
        client.getActiveNamespace.mockReturnValue('team-a');
        apiextensions.readCustomResourceDefinition.mockResolvedValue(definition());
    });

    it('lists namespaced instances in the active namespace and across the cluster with none', async () => {
        customObjects.listNamespacedCustomObject.mockResolvedValue({ items: [widget] });
        customObjects.listCustomObjectForAllNamespaces.mockResolvedValue({ items: [] });

        const listed = await custom.listCustomResourceInstances('widgets.example.com');
        expect(listed).toMatchObject({ kind: 'Widget', namespaced: true, items: [{ name: 'left' }] });
        expect(listed.columns.map((column) => column.name)).toEqual(['Size', 'Ready']);
        expect(customObjects.listNamespacedCustomObject).toHaveBeenCalledWith({
            group: 'example.com',
            version: 'v1',
            plural: 'widgets',
            namespace: 'team-a',
        });

        client.getActiveNamespace.mockReturnValue(null);
        await expect(custom.listCustomResourceInstances('widgets.example.com')).resolves.toMatchObject({ items: [] });
        // That one call names the plural differently from every other custom-object call.
        expect(customObjects.listCustomObjectForAllNamespaces).toHaveBeenCalledWith({
            group: 'example.com',
            version: 'v1',
            resourcePlural: 'widgets',
        });
    });

    it('lists cluster-scoped instances through the cluster call, ignoring the namespace', async () => {
        apiextensions.readCustomResourceDefinition.mockResolvedValue(definition({ scope: 'Cluster' }));
        customObjects.listClusterCustomObject.mockResolvedValue({ items: [{ metadata: { name: 'global' } }] });
        await expect(custom.listCustomResourceInstances('widgets.example.com', 'team-a')).resolves.toMatchObject({
            namespaced: false,
            items: [{ name: 'global', namespace: '' }],
        });
        expect(customObjects.listNamespacedCustomObject).not.toHaveBeenCalled();
    });

    it('reads one instance, and answers not found rather than guessing a namespace', async () => {
        customObjects.getNamespacedCustomObject.mockResolvedValue(widget);
        await expect(custom.getCustomResourceInstance('widgets.example.com', 'left', 'team-a')).resolves.toMatchObject({
            item: { name: 'left', cells: { '.spec.size': 'large' } },
        });

        client.getActiveNamespace.mockReturnValue(null);
        const blind = await custom.getCustomResourceInstance('widgets.example.com', 'left');
        expect(blind.item).toBeNull();
        expect(customObjects.getNamespacedCustomObject).toHaveBeenCalledTimes(1);

        apiextensions.readCustomResourceDefinition.mockResolvedValue(definition({ scope: 'Cluster' }));
        customObjects.getClusterCustomObject.mockResolvedValue({ metadata: { name: 'global' } });
        await expect(custom.getCustomResourceInstance('widgets.example.com', 'global')).resolves.toMatchObject({
            item: { name: 'global' },
        });
    });

    it('refuses a definition that is not installed or serves nothing readable', async () => {
        apiextensions.readCustomResourceDefinition.mockRejectedValue(new ApiException(404, 'gone', {}, {}));
        await expect(custom.listCustomResourceInstances('nope.example.com')).rejects.toMatchObject({
            kind: 'notFound',
            op: 'customResources.list',
        });
        apiextensions.readCustomResourceDefinition.mockResolvedValue(definition({ versions: [] }));
        await expect(custom.getCustomResourceInstance('widgets.example.com', 'left', 'team-a')).rejects.toMatchObject({
            kind: 'invalid',
            op: 'customResources.get',
        });
    });

    it('answers a missing instance as null', async () => {
        customObjects.getNamespacedCustomObject.mockRejectedValue(new ApiException(404, 'gone', {}, {}));
        await expect(custom.getCustomResourceInstance('widgets.example.com', 'gone', 'team-a')).resolves.toMatchObject({
            item: null,
        });
    });
});

describe('instance manifests', () => {
    beforeEach(() => {
        apiextensions.readCustomResourceDefinition.mockReset();
        for (const fn of Object.values(customObjects)) fn.mockReset();
        client.getActiveNamespace.mockReturnValue('team-a');
        apiextensions.readCustomResourceDefinition.mockResolvedValue(definition());
    });

    it('stamps the type meta the API leaves off and serializes the object', async () => {
        customObjects.getNamespacedCustomObject.mockResolvedValue({ ...widget });
        const manifest = await custom.getCustomResourceYaml('widgets.example.com', 'left', 'team-a');
        expect(manifest.kind).toBe('Widget');
        expect(manifest.namespace).toBe('team-a');
        expect(manifest.yaml).toContain('apiVersion: example.com/v1');
        expect(manifest.yaml).toContain('kind: Widget');
        expect(manifest.yaml).toContain('size: large');
    });

    it('reads a cluster-scoped instance through the cluster call, which names no namespace', async () => {
        apiextensions.readCustomResourceDefinition.mockResolvedValue(definition({ scope: 'Cluster' }));
        customObjects.getClusterCustomObject.mockResolvedValue({ metadata: { name: 'global' }, spec: {} });
        const manifest = await custom.getCustomResourceYaml('widgets.example.com', 'global', 'team-a');
        expect(manifest.namespace).toBeUndefined();
        expect(manifest.yaml).toContain('name: global');
        expect(customObjects.getNamespacedCustomObject).not.toHaveBeenCalled();
    });

    it('keeps the type meta an object already carries', async () => {
        customObjects.getNamespacedCustomObject.mockResolvedValue({
            apiVersion: 'example.com/v1alpha1',
            kind: 'Widget',
            metadata: { name: 'left', namespace: 'team-a' },
        });
        const manifest = await custom.getCustomResourceYaml('widgets.example.com', 'left', 'team-a');
        // The object's own version wins: rewriting it would claim a read that never happened.
        expect(manifest.yaml).toContain('apiVersion: example.com/v1alpha1');
    });

    it('names a core-group definition without a leading slash', async () => {
        apiextensions.readCustomResourceDefinition.mockResolvedValue(definition({ group: '' }));
        customObjects.getNamespacedCustomObject.mockResolvedValue({ metadata: { name: 'left' } });
        const manifest = await custom.getCustomResourceYaml('widgets.example.com', 'left', 'team-a');
        expect(manifest.yaml).toContain('apiVersion: v1');
    });

    it('refuses to read a namespaced instance with no namespace known, and reports a missing one', async () => {
        client.getActiveNamespace.mockReturnValue(null);
        await expect(custom.getCustomResourceYaml('widgets.example.com', 'left')).rejects.toMatchObject({
            kind: 'invalid',
        });
        client.getActiveNamespace.mockReturnValue('team-a');
        customObjects.getNamespacedCustomObject.mockRejectedValue(new ApiException(404, 'gone', {}, {}));
        await expect(custom.getCustomResourceYaml('widgets.example.com', 'gone')).rejects.toMatchObject({
            kind: 'notFound',
        });
    });
});
