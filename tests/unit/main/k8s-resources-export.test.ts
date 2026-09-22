import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = { listNamespacedConfigMap: vi.fn(), listNamespacedService: vi.fn(), listPersistentVolume: vi.fn() };
const apps = { listNamespacedDeployment: vi.fn() };
const empty = vi.fn(async () => ({ items: [] }));
const rest = new Proxy({} as Record<string, unknown>, { get: () => empty });
const client = {
    apis: () => ({
        core: new Proxy(core as Record<string, unknown>, { get: (target, key: string) => target[key] ?? empty }),
        apps,
        batch: rest,
        hpa: rest,
        net: rest,
        rbac: rest,
        storage: rest,
        policy: rest,
        scheduling: rest,
        coordination: rest,
        runtime: rest,
        admission: rest,
        apiregistration: rest,
        flowcontrol: rest,
        apiextensions: rest,
    }),
    getActiveNamespace: vi.fn<() => string | null>(() => 'team-a'),
    resolveObjectNamespace: (explicit?: string) => explicit ?? client.getActiveNamespace(),
};
vi.mock('../../../src/main/k8s/client.js', () => client);
vi.mock('../../../src/main/k8s/resources/storage.js', () => ({ listSnapshotObjects: vi.fn(async () => []) }));

const { cleanForExport, exportManifests } = await import('../../../src/main/k8s/resources/export.js');

const configMap = (name: string, namespace = 'team-a') => ({
    metadata: {
        name,
        namespace,
        uid: `uid-${name}`,
        resourceVersion: '4312',
        generation: 2,
        creationTimestamp: '2026-09-01T10:00:00Z',
        selfLink: `/api/v1/namespaces/${namespace}/configmaps/${name}`,
        managedFields: [{ manager: 'kubectl' }],
        labels: { app: 'web' },
        annotations: { owner: 'ara', 'kubectl.kubernetes.io/last-applied-configuration': '{}' },
    },
    data: { key: name },
});

beforeEach(() => {
    vi.clearAllMocks();
    client.getActiveNamespace.mockReturnValue('team-a');
});

describe('cleanForExport', () => {
    it('strips what the server owns and keeps what somebody wrote', () => {
        const clean = cleanForExport({ ...configMap('app-config'), status: { phase: 'Active' } }) as Record<
            string,
            Record<string, unknown>
        >;
        expect(clean.status).toBeUndefined();
        for (const field of ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'selfLink', 'managedFields'])
            expect(clean.metadata[field]).toBeUndefined();
        expect(clean.metadata).toMatchObject({
            name: 'app-config',
            namespace: 'team-a',
            labels: { app: 'web' },
            annotations: { owner: 'ara' },
        });
        expect(clean.data).toEqual({ key: 'app-config' });
    });

    it('drops the annotation map when stripping empties it', () => {
        const clean = cleanForExport({
            metadata: { name: 'x', annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' } },
        }) as { metadata: Record<string, unknown> };
        expect(clean.metadata.annotations).toBeUndefined();
    });

    it('drops the owner reference, whose uid belongs to the cluster the object came from', () => {
        const clean = cleanForExport({
            metadata: { name: 'web-7f9', ownerReferences: [{ kind: 'Deployment', name: 'web', uid: 'uid-web' }] },
        }) as { metadata: Record<string, unknown> };
        expect(clean.metadata.ownerReferences).toBeUndefined();
    });

    it('drops a Service address this cluster assigned but keeps a headless one', () => {
        const assigned = cleanForExport({
            kind: 'Service',
            spec: { clusterIP: '10.43.0.17', clusterIPs: ['10.43.0.17'], selector: { app: 'web' } },
        }) as { spec: Record<string, unknown> };
        expect(assigned.spec).toEqual({ selector: { app: 'web' } });

        const headless = cleanForExport({ kind: 'Service', spec: { clusterIP: 'None', clusterIPs: ['None'] } }) as {
            spec: Record<string, unknown>;
        };
        expect(headless.spec).toEqual({ clusterIP: 'None', clusterIPs: ['None'] });
    });

    it('drops the null creation timestamp the API server prints inside a pod template', () => {
        const clean = cleanForExport({
            kind: 'Deployment',
            spec: { template: { metadata: { creationTimestamp: null, labels: { app: 'web' } } } },
        }) as { spec: { template: { metadata: Record<string, unknown> } } };
        expect(clean.spec.template.metadata).toEqual({ labels: { app: 'web' } });
    });

    it('leaves the object the caller passed untouched', () => {
        const object = configMap('app-config');
        const before = structuredClone(object);
        cleanForExport(object);
        expect(object).toEqual(before);
    });
});

describe('exportManifests', () => {
    it('writes one document per selected object, in the order the rows were selected', async () => {
        core.listNamespacedConfigMap.mockResolvedValue({ items: [configMap('app-config'), configMap('other')] });
        const result = await exportManifests({
            kind: 'ConfigMap',
            clean: false,
            targets: [
                { name: 'other', namespace: 'team-a' },
                { name: 'app-config', namespace: 'team-a' },
            ],
        });
        expect(result.count).toBe(2);
        const documents = result.text.split('---\n');
        expect(documents).toHaveLength(2);
        expect(documents[0]).toContain('name: other');
        expect(documents[1]).toContain('name: app-config');
        // Read as the cluster holds them: the type meta the list omits is restored, nothing else.
        expect(documents[0]?.startsWith('apiVersion: v1\nkind: ConfigMap\n')).toBe(true);
        expect(result.text).toContain('uid: uid-other');
    });

    it('strips the server-owned fields when the export asks for it', async () => {
        core.listNamespacedConfigMap.mockResolvedValue({ items: [configMap('app-config')] });
        const result = await exportManifests({
            kind: 'ConfigMap',
            clean: true,
            targets: [{ name: 'app-config', namespace: 'team-a' }],
        });
        expect(result.text).not.toContain('uid:');
        expect(result.text).not.toContain('resourceVersion:');
        expect(result.text).toContain('kind: ConfigMap');
        expect(result.text).toContain('owner: ara');
    });

    it('lists once per namespace, however many rows the selection holds', async () => {
        core.listNamespacedConfigMap.mockImplementation(async ({ namespace }: { namespace: string }) => ({
            items: [configMap('app-config', namespace), configMap('other', namespace)],
        }));
        const result = await exportManifests({
            kind: 'ConfigMap',
            clean: false,
            targets: [
                { name: 'app-config', namespace: 'team-a' },
                { name: 'other', namespace: 'team-a' },
                { name: 'app-config', namespace: 'team-b' },
            ],
        });
        expect(result.count).toBe(3);
        expect(core.listNamespacedConfigMap).toHaveBeenCalledTimes(2);
        expect(core.listNamespacedConfigMap).toHaveBeenCalledWith({ namespace: 'team-a' });
        expect(core.listNamespacedConfigMap).toHaveBeenCalledWith({ namespace: 'team-b' });
    });

    it('reads a cluster-scoped kind without a namespace', async () => {
        core.listPersistentVolume.mockResolvedValue({ items: [{ metadata: { name: 'pv-1' } }] });
        const result = await exportManifests({ kind: 'PersistentVolume', clean: false, targets: [{ name: 'pv-1' }] });
        expect(result.text).toContain('kind: PersistentVolume');
        expect(result.count).toBe(1);
    });

    it('leaves out an object that has since been deleted and counts what it wrote', async () => {
        core.listNamespacedConfigMap.mockResolvedValue({ items: [configMap('app-config')] });
        const result = await exportManifests({
            kind: 'ConfigMap',
            clean: false,
            targets: [
                { name: 'app-config', namespace: 'team-a' },
                { name: 'ghost', namespace: 'team-a' },
            ],
        });
        expect(result.count).toBe(1);
        expect(result.text).not.toContain('ghost');
    });

    it('reports a selection nothing could be read for rather than writing an empty file', async () => {
        core.listNamespacedConfigMap.mockResolvedValue({ items: [] });
        await expect(
            exportManifests({ kind: 'ConfigMap', clean: false, targets: [{ name: 'ghost', namespace: 'team-a' }] }),
        ).rejects.toMatchObject({
            kind: 'notFound',
            op: 'resources.exportYaml',
            detail: 'ConfigMap "ghost" was not found.',
        });
        await expect(
            exportManifests({
                kind: 'ConfigMap',
                clean: false,
                targets: [
                    { name: 'ghost', namespace: 'team-a' },
                    { name: 'spectre', namespace: 'team-a' },
                ],
            }),
        ).rejects.toMatchObject({ detail: 'None of the 2 selected ConfigMaps was found.' });
    });

    it('names the file after the object when one is selected, after the kind otherwise', async () => {
        apps.listNamespacedDeployment.mockResolvedValue({
            items: [{ metadata: { name: 'web', namespace: 'team-a' } }, { metadata: { name: 'api' } }],
        });
        const one = await exportManifests({
            kind: 'Deployment',
            clean: false,
            targets: [{ name: 'web', namespace: 'team-a' }],
        });
        expect(one.defaultName).toBe('web.yaml');
        const many = await exportManifests({
            kind: 'Deployment',
            clean: false,
            targets: [
                { name: 'web', namespace: 'team-a' },
                { name: 'api', namespace: 'team-a' },
            ],
        });
        expect(many.defaultName).toBe('deployment-export.yaml');
    });

    it('classifies a failed list the way every other cluster read is classified', async () => {
        core.listNamespacedConfigMap.mockRejectedValue(Object.assign(new Error('nope'), { code: 403 }));
        await expect(
            exportManifests({
                kind: 'ConfigMap',
                clean: false,
                targets: [{ name: 'app-config', namespace: 'team-a' }],
            }),
        ).rejects.toMatchObject({ kind: 'forbidden', op: 'resources.exportYaml' });
    });
});
