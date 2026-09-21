import { gzipSync } from 'node:zlib';
import { ApiException, type V1CustomResourceDefinition, type V1Secret } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiextensions = { listCustomResourceDefinition: vi.fn(), readCustomResourceDefinition: vi.fn() };
const core = {
    listNamespacedSecret: vi.fn(),
    listSecretForAllNamespaces: vi.fn(),
    createNamespacedSecret: vi.fn(),
    replaceNamespacedSecret: vi.fn(),
    deleteNamespacedSecret: vi.fn(),
};
const objects = { create: vi.fn(), read: vi.fn(), replace: vi.fn(), delete: vi.fn() };
const client = {
    apis: () => ({ apiextensions, core, objects }),
    getActiveNamespace: vi.fn<() => string | null>(),
    activeContextName: vi.fn<() => string>(() => 'alpha'),
    readOrNull: async <T>(read: () => Promise<T>) => {
        try {
            return await read();
        } catch (error) {
            if (error instanceof ApiException && error.code === 404) return undefined;
            throw error;
        }
    },
    listItems: async <T>(
        ns: string | undefined,
        namespaced: (ns: string) => Promise<{ items: T[] }>,
        all: () => Promise<{ items: T[] }>,
    ) => {
        const resolved = ns ?? client.getActiveNamespace() ?? undefined;
        return resolved ? namespaced(resolved) : all();
    },
};
vi.mock('../../../src/main/k8s/client.js', () => client);

const crds = await import('../../../src/main/k8s/resources/crds.js');
const helm = await import('../../../src/main/k8s/resources/helm.js');

const NOW = Date.parse('2026-09-15T12:00:00Z');
const HOUR = 3600 * 1000;

const crd: V1CustomResourceDefinition = {
    metadata: { name: 'helmcharts.helm.cattle.io', creationTimestamp: new Date(NOW - 3 * HOUR) },
    spec: {
        group: 'helm.cattle.io',
        scope: 'Namespaced',
        names: { kind: 'HelmChart', plural: 'helmcharts' },
        versions: [
            { name: 'v1alpha1', served: true, storage: false },
            { name: 'v1', served: true, storage: true },
        ],
    },
};

/** A release Secret the way Helm writes one: base64(gzip(json)), which the API base64s again. */
function releaseSecret(release: Record<string, unknown>): V1Secret {
    const gzipped = gzipSync(Buffer.from(JSON.stringify(release), 'utf8')).toString('base64');
    return {
        metadata: { name: `sh.helm.release.v1.${String(release.name)}.v${String(release.version)}` },
        type: 'helm.sh/release.v1',
        data: { release: Buffer.from(gzipped, 'utf8').toString('base64') },
    };
}

const deployed = {
    name: 'traefik',
    namespace: 'kube-system',
    version: 2,
    info: {
        status: 'deployed',
        last_deployed: new Date(NOW - HOUR).toISOString(),
        description: 'Upgrade complete',
    },
    chart: { metadata: { name: 'traefik', version: '28.0.0', appVersion: '3.0.0' } },
    config: { service: { type: 'LoadBalancer' } },
};
const superseded = {
    ...deployed,
    version: 1,
    info: { status: 'superseded', last_deployed: new Date(NOW - 2 * HOUR).toISOString(), description: 'Install' },
    config: {},
};

beforeEach(() => {
    vi.clearAllMocks();
    client.getActiveNamespace.mockReturnValue(null);
});

describe('custom resource definitions', () => {
    it('reports the stored version, the group, scope and kind', () => {
        expect(crds.toCustomResource(crd, NOW)).toEqual({
            name: 'helmcharts.helm.cattle.io',
            group: 'helm.cattle.io',
            version: 'v1',
            scope: 'Namespaced',
            kind: 'HelmChart',
            age: '3h',
        });
    });

    it('falls back to the first version when none is marked for storage', () => {
        const noStorage = {
            ...crd,
            spec: { ...crd.spec!, versions: [{ name: 'v1beta1', served: true, storage: false }] },
        };
        expect(crds.toCustomResource(noStorage, NOW).version).toBe('v1beta1');
    });

    it('shows a dash for every field a stripped definition omits', () => {
        expect(crds.toCustomResource({}, NOW)).toMatchObject({
            name: '',
            group: '—',
            version: '—',
            scope: '—',
            kind: '—',
        });
    });

    it('lists and reads definitions and reports a missing one as null', async () => {
        apiextensions.listCustomResourceDefinition.mockResolvedValue({ items: [crd] });
        apiextensions.readCustomResourceDefinition.mockResolvedValue({
            ...crd,
            metadata: { ...crd.metadata, labels: { origin: 'k3s' } },
        });
        expect(await crds.listCustomResources()).toHaveLength(1);
        expect((await crds.getCustomResource('helmcharts.helm.cattle.io'))?.labels).toEqual([['origin', 'k3s']]);

        apiextensions.readCustomResourceDefinition.mockRejectedValue(new ApiException(404, 'gone', {}, {}));
        expect(await crds.getCustomResource('ghost')).toBeNull();
    });
});

describe('helm releases', () => {
    it('decodes a release Secret through both base64 layers and the gzip', () => {
        expect(helm.decodeRelease(releaseSecret(deployed))).toMatchObject({ name: 'traefik', version: 2 });
    });

    it('treats a Secret without release data or with unreadable data as no release', () => {
        expect(helm.decodeRelease({ data: {} })).toBeNull();
        expect(helm.decodeRelease({ data: { release: 'bm90LWd6aXA=' } })).toBeNull();
    });

    it('maps every helm state onto the badge vocabulary', () => {
        expect(helm.helmStatus('deployed')).toBe('Deployed');
        expect(helm.helmStatus('superseded')).toBe('Superseded');
        expect(helm.helmStatus('failed')).toBe('Failed');
        expect(helm.helmStatus('pending-upgrade')).toBe('Progressing');
        expect(helm.helmStatus('uninstalling')).toBe('Terminating');
        expect(helm.helmStatus('uninstalled')).toBe('Unknown');
        expect(helm.helmStatus(undefined)).toBe('Unknown');
        expect(helm.helmStatus('something-new')).toBe('Unknown');
    });

    it('dumps user-supplied values to YAML and omits them when the release uses defaults', () => {
        expect(helm.releaseValues(deployed)).toBe('service:\n  type: LoadBalancer\n');
        expect(helm.releaseValues(superseded)).toBeUndefined();
        expect(helm.releaseValues({})).toBeUndefined();
        // A cyclic config cannot be dumped; the tab then reads as having no values.
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(helm.releaseValues({ config: cyclic })).toBeUndefined();
    });

    it('carries the rendered manifest of a revision, and nothing when it rendered none', () => {
        expect(helm.releaseManifest({ ...deployed, manifest: 'kind: Service\n' })).toBe('kind: Service\n');
        expect(helm.releaseManifest(deployed)).toBeUndefined();
        expect(helm.releaseManifest({ ...deployed, manifest: '   \n' })).toBeUndefined();
    });

    it('cuts an oversized manifest on a line boundary and says so in the manifest itself', () => {
        const line = `${'a'.repeat(99)}\n`;
        const manifest = line.repeat(6000);
        const cut = helm.releaseManifest({ ...deployed, manifest }) ?? '';
        expect(cut.length).toBeLessThan(manifest.length);
        // Whole lines only: the note is the sole trailing line, so nothing is cut mid-key.
        const lines = cut.split('\n');
        expect(lines.at(-2)).toMatch(/^# /);
        expect(lines.filter((l) => l.startsWith('a')).every((l) => l.length === 99)).toBe(true);
    });

    it('puts values and the manifest on a release only when a detail read supplies them', () => {
        expect(helm.toRelease(deployed, {}, NOW)).toMatchObject({ values: undefined, manifest: undefined });
        expect(helm.toRelease(deployed, { values: 'a: 1\n', manifest: 'kind: Service\n' }, NOW)).toMatchObject({
            values: 'a: 1\n',
            manifest: 'kind: Service\n',
        });
    });

    it('keeps only the highest revision of each release', () => {
        expect(helm.latestPerRelease([superseded, deployed]).map((r) => r.version)).toEqual([2]);
        expect(
            helm
                .latestPerRelease([deployed, { ...deployed, namespace: 'other', version: 5 }])
                .map((r) => `${r.namespace}/${r.version}`),
        ).toEqual(['kube-system/2', 'other/5']);
    });

    it('lists the current release of each name with its chart and revision', async () => {
        core.listSecretForAllNamespaces.mockResolvedValue({
            items: [releaseSecret(superseded), releaseSecret(deployed), { type: 'Opaque', data: {} }],
        });
        const releases = await helm.listReleases();
        expect(releases).toEqual([
            {
                name: 'traefik',
                namespace: 'kube-system',
                chart: 'traefik-28.0.0',
                revision: 2,
                status: 'Deployed',
                updated: expect.any(String),
                values: undefined,
            },
        ]);
        expect(core.listSecretForAllNamespaces).toHaveBeenCalledWith({ fieldSelector: 'type=helm.sh/release.v1' });
    });

    it('reads the current release of one name in its namespace with its values, and null when absent', async () => {
        core.listNamespacedSecret.mockResolvedValue({
            items: [releaseSecret(superseded), releaseSecret(deployed)],
        });
        expect(await helm.getRelease('traefik', 'kube-system')).toMatchObject({
            revision: 2,
            values: 'service:\n  type: LoadBalancer\n',
        });
        expect(core.listNamespacedSecret).toHaveBeenCalledWith({
            namespace: 'kube-system',
            fieldSelector: 'type=helm.sh/release.v1',
        });
        // Secrets listed in a namespace that holds no such release, and a name nothing carries.
        expect(await helm.getRelease('traefik', 'other')).toBeNull();
        expect(await helm.getRelease('nothing', 'kube-system')).toBeNull();
        expect(core.listSecretForAllNamespaces).not.toHaveBeenCalled();
    });

    it('reads a release in the namespace its screen names even when another namespace is active', async () => {
        client.getActiveNamespace.mockReturnValue('default');
        core.listNamespacedSecret.mockResolvedValue({ items: [releaseSecret(deployed)] });
        expect(await helm.getRelease('traefik', 'kube-system')).toMatchObject({ revision: 2 });
        expect(core.listNamespacedSecret).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'kube-system' }));
    });

    it('lists the revisions of a release newest first', async () => {
        core.listNamespacedSecret.mockResolvedValue({
            items: [releaseSecret(superseded), releaseSecret(deployed)],
        });
        expect(await helm.getReleaseRevisions('traefik', 'kube-system')).toMatchObject([
            { rev: '2', status: 'Deployed', chartVersion: '28.0.0', description: 'Upgrade complete' },
            { rev: '1', status: 'Superseded', chartVersion: '28.0.0', description: 'Install' },
        ]);
    });

    it('skips a release whose payload inflates past the ceiling instead of decoding it', () => {
        // A tiny gzip stream that expands to far more than any real release.
        const bomb = gzipSync(Buffer.alloc(48 * 1024 * 1024, 0x20));
        const secret = { data: { release: Buffer.from(bomb.toString('base64')).toString('base64') } } as V1Secret;
        expect(helm.decodeRelease(secret)).toBeNull();
    });

    it('derives the chart list from the installed releases, one row per chart', async () => {
        core.listSecretForAllNamespaces.mockResolvedValue({
            items: [
                releaseSecret(superseded),
                releaseSecret(deployed),
                releaseSecret({ ...deployed, name: 'traefik-crd', namespace: 'kube-system' }),
                releaseSecret({ name: 'nameless', namespace: 'default', version: 1 }),
            ],
        });
        expect(await helm.listHelmCharts()).toEqual([
            {
                name: 'traefik',
                repository: '—',
                latestVersion: '28.0.0',
                appVersion: '3.0.0',
                description: 'Upgrade complete',
            },
        ]);
    });

    it('reads secrets from the active namespace alone when one is selected', async () => {
        client.getActiveNamespace.mockReturnValue('kube-system');
        core.listNamespacedSecret.mockResolvedValue({ items: [releaseSecret(deployed)] });
        expect(await helm.listReleases()).toHaveLength(1);
        expect(core.listNamespacedSecret).toHaveBeenCalledWith({
            namespace: 'kube-system',
            fieldSelector: 'type=helm.sh/release.v1',
        });
    });

    it('names a chart as a dash when the release carries no chart metadata', async () => {
        core.listSecretForAllNamespaces.mockResolvedValue({ items: [releaseSecret({ name: 'bare', version: 1 })] });
        expect((await helm.listReleases())[0]).toMatchObject({ chart: '—', namespace: '', status: 'Unknown' });
    });

    it('classifies a failed read as a Kubernetes error carrying the operation', async () => {
        core.listSecretForAllNamespaces.mockRejectedValue(new ApiException(403, 'forbidden', {}, {}));
        core.listNamespacedSecret.mockRejectedValue(new ApiException(403, 'forbidden', {}, {}));
        await expect(helm.listReleases()).rejects.toMatchObject({ kind: 'forbidden', op: 'releases.list' });
        await expect(helm.listHelmCharts()).rejects.toMatchObject({ op: 'helmCharts.list' });
        await expect(helm.getRelease('traefik', 'kube-system')).rejects.toMatchObject({ op: 'releases.get' });
        await expect(helm.getReleaseRevisions('traefik', 'kube-system')).rejects.toMatchObject({
            op: 'releases.revisions',
        });
    });
});

describe('helm writes', () => {
    const CONFIG_MAP = [
        'apiVersion: v1',
        'kind: ConfigMap',
        'metadata:',
        '  name: demo-config',
        'data:',
        '  colour: blue',
    ].join('\n');
    const WITH_SERVICE = [
        CONFIG_MAP,
        '---',
        'apiVersion: v1',
        'kind: Service',
        'metadata:',
        '  name: demo-svc',
        '  annotations:',
        '    helm.sh/resource-policy: keep',
    ].join('\n');

    const v1 = { ...superseded, name: 'demo', namespace: 'team-a', version: 1, manifest: CONFIG_MAP };
    const v2 = { ...deployed, name: 'demo', namespace: 'team-a', version: 2, manifest: WITH_SERVICE };
    const ON_ALPHA = { context: 'alpha', name: 'demo', namespace: 'team-a' };

    /** What the decoded release Secret of each revision looks like to the reader. */
    const twoRevisions = () => ({ items: [releaseSecret(v1), releaseSecret(v2)] });

    beforeEach(() => {
        vi.clearAllMocks();
        client.activeContextName.mockReturnValue('alpha');
        core.listNamespacedSecret.mockResolvedValue(twoRevisions());
        core.createNamespacedSecret.mockResolvedValue({});
        core.replaceNamespacedSecret.mockResolvedValue({});
        core.deleteNamespacedSecret.mockResolvedValue({});
        objects.create.mockResolvedValue({});
        objects.delete.mockResolvedValue({});
        objects.read.mockResolvedValue({ metadata: { resourceVersion: '7' } });
        objects.replace.mockResolvedValue({});
    });

    describe('reading a rendered manifest', () => {
        it('gives namespaced objects the release namespace and leaves cluster-scoped ones alone', () => {
            const manifest = [
                CONFIG_MAP,
                '---',
                'apiVersion: v1',
                'kind: Namespace',
                'metadata:',
                '  name: other',
            ].join('\n');
            expect(helm.manifestObjects(manifest, 'team-a').map((o) => [o.kind, o.metadata.namespace])).toEqual([
                ['ConfigMap', 'team-a'],
                ['Namespace', undefined],
            ]);
        });

        it('ignores empty documents, and a manifest it cannot read rather than guessing', () => {
            expect(helm.manifestObjects('---\n\n---\n', 'team-a')).toEqual([]);
            expect(helm.manifestObjects('a:\n b: [', 'team-a')).toEqual([]);
            expect(helm.manifestObjects(undefined, 'team-a')).toEqual([]);
        });

        it('names the revision Secret the way Helm names its own', () => {
            expect(helm.releaseSecretName('demo', 3)).toBe('sh.helm.release.v1.demo.v3');
        });

        it('reads back what it encodes', () => {
            const encoded = helm.encodeRelease({ name: 'demo', version: 4 });
            const secret = { type: 'helm.sh/release.v1', data: { release: Buffer.from(encoded).toString('base64') } };
            expect(helm.decodeRelease(secret)).toMatchObject({ name: 'demo', version: 4 });
        });

        it('spots what one revision had and another does not', () => {
            const from = helm.manifestObjects(WITH_SERVICE, 'team-a');
            const to = helm.manifestObjects(CONFIG_MAP, 'team-a');
            expect(helm.goneBetween(from, to).map((o) => o.metadata.name)).toEqual(['demo-svc']);
            expect(helm.goneBetween(to, from)).toEqual([]);
        });
    });

    describe('rollbackRelease', () => {
        it('re-applies the revision, removes what it never had, and records a new revision', async () => {
            const result = await helm.rollbackRelease({ ...ON_ALPHA, revision: 1 });
            expect(result).toMatchObject({ name: 'demo', revision: 3, removed: 0, kept: 1 });

            // Revision 1's ConfigMap is applied again...
            expect(objects.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    kind: 'ConfigMap',
                    metadata: expect.objectContaining({ name: 'demo-config' }),
                }),
            );
            // ...and the Service revision 2 added is left alone, because the chart asked for it to be kept.
            expect(objects.delete).not.toHaveBeenCalled();

            // The new revision is stored as Helm stores one, and the old one is marked superseded.
            const created = core.createNamespacedSecret.mock.calls[0][0].body;
            expect(created.metadata.name).toBe('sh.helm.release.v1.demo.v3');
            expect(created.metadata.labels).toMatchObject({ owner: 'helm', status: 'deployed', version: '3' });
            expect(
                helm.decodeRelease({
                    type: 'helm.sh/release.v1',
                    data: { release: Buffer.from(created.stringData.release).toString('base64') },
                }),
            ).toMatchObject({
                version: 3,
                info: { status: 'deployed', description: 'Rollback to 1' },
            });
            expect(core.replaceNamespacedSecret.mock.calls[0][0].body.metadata.labels.status).toBe('superseded');
        });

        it('replaces an object that is already there instead of failing on it', async () => {
            objects.create.mockRejectedValueOnce(new ApiException(409, 'exists', null, {}));
            await helm.rollbackRelease({ ...ON_ALPHA, revision: 1 });
            expect(objects.read).toHaveBeenCalled();
            expect(objects.replace).toHaveBeenCalledWith(
                expect.objectContaining({ metadata: expect.objectContaining({ resourceVersion: '7' }) }),
            );
        });

        it('removes an object the target revision never rendered', async () => {
            // Roll back from a revision that added an unkept object.
            const withExtra = {
                ...v2,
                manifest: [CONFIG_MAP, '---', 'apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: extra'].join(
                    '\n',
                ),
            };
            core.listNamespacedSecret.mockResolvedValue({ items: [releaseSecret(v1), releaseSecret(withExtra)] });
            const result = await helm.rollbackRelease({ ...ON_ALPHA, revision: 1 });
            expect(objects.delete).toHaveBeenCalledWith(
                expect.objectContaining({ metadata: expect.objectContaining({ name: 'extra' }) }),
            );
            expect(result).toMatchObject({ removed: 1, kept: 0 });
        });

        it('refuses a revision the release never had, and the one it already runs', async () => {
            await expect(helm.rollbackRelease({ ...ON_ALPHA, revision: 9 })).rejects.toMatchObject({
                kind: 'notFound',
                detail: expect.stringContaining('no revision 9'),
            });
            await expect(helm.rollbackRelease({ ...ON_ALPHA, revision: 2 })).rejects.toMatchObject({
                kind: 'invalid',
                detail: expect.stringContaining('already runs revision 2'),
            });
            expect(core.createNamespacedSecret).not.toHaveBeenCalled();
        });

        it('refuses a release that is not there, and one aimed at another context', async () => {
            core.listNamespacedSecret.mockResolvedValue({ items: [] });
            await expect(helm.rollbackRelease({ ...ON_ALPHA, revision: 1 })).rejects.toMatchObject({
                kind: 'notFound',
            });
            client.activeContextName.mockReturnValue('beta');
            core.listNamespacedSecret.mockResolvedValue(twoRevisions());
            await expect(helm.rollbackRelease({ ...ON_ALPHA, revision: 1 })).rejects.toMatchObject({
                kind: 'conflict',
            });
            expect(objects.create).not.toHaveBeenCalled();
        });
    });

    describe('uninstallRelease', () => {
        it('deletes what the release rendered, keeps what the chart kept, and forgets the history', async () => {
            const result = await helm.uninstallRelease({ ...ON_ALPHA, keepHistory: false });
            expect(result).toMatchObject({ removed: 1, kept: 1 });
            expect(objects.delete).toHaveBeenCalledTimes(1);
            expect(objects.delete).toHaveBeenCalledWith(
                expect.objectContaining({ metadata: expect.objectContaining({ name: 'demo-config' }) }),
            );
            // Both revisions' Secrets go.
            expect(core.deleteNamespacedSecret).toHaveBeenCalledTimes(2);
        });

        it('keeps the history marked uninstalled when asked to', async () => {
            await helm.uninstallRelease({ ...ON_ALPHA, keepHistory: true });
            expect(core.deleteNamespacedSecret).not.toHaveBeenCalled();
            const body = core.replaceNamespacedSecret.mock.calls[0][0].body;
            expect(body.metadata.labels.status).toBe('uninstalled');
            // The rewritten Secret carries the status in its payload too, not only in the label.
            expect(
                helm.decodeRelease({
                    type: 'helm.sh/release.v1',
                    data: { release: Buffer.from(body.stringData.release).toString('base64') },
                }),
            ).toMatchObject({
                info: { status: 'uninstalled' },
            });
        });

        it('treats an object that is already gone as gone', async () => {
            objects.delete.mockRejectedValue(new ApiException(404, 'gone', null, {}));
            await expect(helm.uninstallRelease({ ...ON_ALPHA, keepHistory: false })).resolves.toMatchObject({
                removed: 1,
            });
        });

        it('refuses to uninstall a release that is not there, or from another context', async () => {
            core.listNamespacedSecret.mockResolvedValue({ items: [] });
            await expect(helm.uninstallRelease({ ...ON_ALPHA, keepHistory: false })).rejects.toMatchObject({
                kind: 'notFound',
            });
            client.activeContextName.mockReturnValue('beta');
            core.listNamespacedSecret.mockResolvedValue(twoRevisions());
            await expect(helm.uninstallRelease({ ...ON_ALPHA, keepHistory: false })).rejects.toMatchObject({
                kind: 'conflict',
            });
            expect(objects.delete).not.toHaveBeenCalled();
        });
    });
});
