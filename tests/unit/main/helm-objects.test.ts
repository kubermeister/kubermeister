import { gzipSync } from 'node:zlib';
import { ApiException, type V1Secret } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = { listNamespacedSecret: vi.fn(), listSecretForAllNamespaces: vi.fn() };
const objects = { list: vi.fn() };
const client = {
    apis: () => ({ core, objects }),
    getActiveNamespace: vi.fn<() => string | null>(() => null),
    activeContextName: vi.fn<() => string>(() => 'alpha'),
    listItems: async <T>(
        ns: string | undefined,
        namespaced: (ns: string) => Promise<{ items: T[] }>,
        all: () => Promise<{ items: T[] }>,
    ) => (ns ? namespaced(ns) : all()),
};
vi.mock('../../../src/main/k8s/client.js', () => client);

const listRowsOf = vi.fn();
vi.mock('../../../src/main/k8s/resources/index.js', () => ({ listRowsOf }));

const { K8sError } = await import('../../../src/main/k8s/errors.js');
const helm = await import('../../../src/main/k8s/resources/helm.js');
const helmObjects = await import('../../../src/main/k8s/resources/helm-objects.js');

type GroupAnswer = import('../../../src/main/k8s/resources/helm-objects.js').GroupAnswer;

const MANIFEST = [
    '# Source: web/templates/deployment.yaml',
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: web',
    '---',
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: web-config',
    '---',
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: web-extra',
    '---',
    'apiVersion: rbac.authorization.k8s.io/v1',
    'kind: ClusterRole',
    'metadata:',
    '  name: web-reader',
    '---',
    'apiVersion: messaging.example.com/v1',
    'kind: Queue',
    'metadata:',
    '  name: web-jobs',
    '---',
    // A custom resource that happens to share a core kind's name must not be read as the core kind.
    'apiVersion: serving.knative.dev/v1',
    'kind: Service',
    'metadata:',
    '  name: web-edge',
    '',
].join('\n');

const rendered = () => helm.manifestObjects(MANIFEST, 'team-a');

function releaseSecret(release: Record<string, unknown>): V1Secret {
    const gzipped = gzipSync(Buffer.from(JSON.stringify(release), 'utf8')).toString('base64');
    return {
        metadata: { name: `sh.helm.release.v1.${String(release.name)}.v${String(release.version)}` },
        type: 'helm.sh/release.v1',
        data: { release: Buffer.from(gzipped, 'utf8').toString('base64') },
    };
}

const found = (entries: [string, string | null][]): GroupAnswer => ({ found: new Map(entries) });

describe('the lists a release needs', () => {
    it('reads one list per kind and namespace, however many objects share it', () => {
        const groups = helmObjects.readGroups(rendered());
        expect(groups.map((group) => group.key)).toEqual([
            'Deployment|team-a',
            'v1|ConfigMap|team-a',
            'rbac.authorization.k8s.io/v1|ClusterRole|',
            'messaging.example.com/v1|Queue|team-a',
            'serving.knative.dev/v1|Service|team-a',
        ]);
    });

    it('reads a kind with a status through its own transform, and every other kind at its manifest version', () => {
        const [deployment, configMaps, clusterRole, queue, knative] = helmObjects.readGroups(rendered());
        expect(deployment).toMatchObject({ statusKind: 'Deployment', namespace: 'team-a' });
        expect(configMaps).toMatchObject({ apiVersion: 'v1', kind: 'ConfigMap' });
        expect(configMaps?.statusKind).toBeUndefined();
        // Cluster-scoped: listed cluster-wide, never in the release's namespace.
        expect(clusterRole).toMatchObject({ kind: 'ClusterRole', namespace: undefined });
        expect(queue).toMatchObject({ apiVersion: 'messaging.example.com/v1', kind: 'Queue' });
        expect(knative?.statusKind).toBeUndefined();
    });

    it('treats any version of a registered group as the same list', () => {
        const [older] = helmObjects.readGroups(
            helm.manifestObjects('apiVersion: apps/v1beta2\nkind: Deployment\nmetadata:\n  name: web\n', 'team-a'),
        );
        expect(older).toMatchObject({ key: 'Deployment|team-a', statusKind: 'Deployment' });
    });
});

describe('what the cluster holds of a release', () => {
    const answers = new Map<string, GroupAnswer>([
        ['Deployment|team-a', found([['web', 'Progressing']])],
        ['v1|ConfigMap|team-a', found([['web-config', null]])],
        ['rbac.authorization.k8s.io/v1|ClusterRole|', { unreadable: 'Not allowed to list ClusterRole objects.' }],
        ['messaging.example.com/v1|Queue|team-a', found([['web-jobs', null]])],
        ['serving.knative.dev/v1|Service|team-a', found([])],
    ]);

    it('gives each rendered object its state, in the order the manifest rendered them', () => {
        const rows = helmObjects.toReleaseObjects(rendered(), answers);
        expect(rows.map((row) => [row.kind, row.name, row.state])).toEqual([
            ['Deployment', 'web', 'Present'],
            ['ConfigMap', 'web-config', 'Present'],
            ['ConfigMap', 'web-extra', 'Missing'],
            ['ClusterRole', 'web-reader', 'Unknown'],
            ['Queue', 'web-jobs', 'Present'],
            ['Service', 'web-edge', 'Missing'],
        ]);
    });

    it("carries a kind's own status word with the kind whose tone map colours it", () => {
        const [deployment, configMap] = helmObjects.toReleaseObjects(rendered(), answers);
        expect(deployment?.status).toEqual({ kind: 'Deployment', value: 'Progressing' });
        expect(configMap?.status).toBeNull();
    });

    it('links an object to its screen only when the registry has one and the object is there', () => {
        const rows = helmObjects.toReleaseObjects(rendered(), answers);
        const byName = new Map(rows.map((row) => [row.name, row]));
        expect(byName.get('web')?.path).toBe('/workloads/deployments/team-a/web');
        expect(byName.get('web-config')?.path).toBe('/workloads/configmaps/team-a/web-config');
        expect(byName.get('web-reader')?.path).toBe('/access/clusterroles/web-reader');
        expect(byName.get('web-extra')?.path).toBeNull();
        expect(byName.get('web-jobs')?.path).toBeNull();
        expect(byName.get('web-edge')?.path).toBeNull();
    });

    it('says why an object is unknown, and never calls a refused list missing', () => {
        const reader = helmObjects.toReleaseObjects(rendered(), answers).find((row) => row.name === 'web-reader');
        expect(reader).toMatchObject({ state: 'Unknown', note: 'Not allowed to list ClusterRole objects.' });
        expect(reader?.namespace).toBeUndefined();
    });

    it('lists an object rendered twice once', () => {
        const twice = [...rendered(), ...rendered()];
        expect(helmObjects.toReleaseObjects(twice, answers)).toHaveLength(6);
    });
});

describe('reading a release’s objects', () => {
    const current = {
        name: 'web',
        namespace: 'team-a',
        version: 3,
        info: { status: 'deployed' },
        manifest: MANIFEST,
    };
    const older = { ...current, version: 2, manifest: 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: old\n' };

    beforeEach(() => {
        core.listNamespacedSecret.mockReset();
        core.listNamespacedSecret.mockResolvedValue({ items: [releaseSecret(older), releaseSecret(current)] });
        listRowsOf.mockReset();
        listRowsOf.mockResolvedValue([{ name: 'web', status: 'Healthy' }]);
        objects.list.mockReset();
        objects.list.mockImplementation(async (apiVersion: string, kind: string) => {
            if (kind === 'ConfigMap') return { items: [{ metadata: { name: 'web-config' } }] };
            if (kind === 'ClusterRole') throw new ApiException(403, 'Forbidden', {}, {});
            if (kind === 'Queue') throw new ApiException(404, 'Not Found', {}, {});
            if (apiVersion === 'serving.knative.dev/v1') {
                throw new Error('Unrecognized API version and kind: serving.knative.dev/v1 Service');
            }
            return { items: [] };
        });
    });

    it("reads the current revision's objects with one list per kind and namespace", async () => {
        const rows = await helmObjects.getReleaseObjects('web', 'team-a');
        expect(core.listNamespacedSecret).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'team-a' }));
        expect(listRowsOf).toHaveBeenCalledTimes(1);
        expect(listRowsOf).toHaveBeenCalledWith('Deployment', 'team-a');
        // Two ConfigMaps, one list; nothing from the older revision's manifest is read at all.
        expect(objects.list).toHaveBeenCalledTimes(4);
        expect(objects.list).toHaveBeenCalledWith('v1', 'ConfigMap', 'team-a');
        expect(objects.list).toHaveBeenCalledWith('rbac.authorization.k8s.io/v1', 'ClusterRole', undefined);
        expect(objects.list).not.toHaveBeenCalledWith('v1', 'Secret', expect.anything());
        expect(rows.map((row) => [row.name, row.state, row.status?.value ?? null])).toEqual([
            ['web', 'Present', 'Healthy'],
            ['web-config', 'Present', null],
            ['web-extra', 'Missing', null],
            ['web-reader', 'Unknown', null],
            ['web-jobs', 'Missing', null],
            ['web-edge', 'Missing', null],
        ]);
    });

    it('fails the whole read on a failure that is not about one kind', async () => {
        listRowsOf.mockRejectedValue(new K8sError('unreachable', 'The cluster API server is unreachable.', 'x'));
        await expect(helmObjects.getReleaseObjects('web', 'team-a')).rejects.toMatchObject({ kind: 'unreachable' });
    });

    it('answers not found for a release that does not exist', async () => {
        await expect(helmObjects.getReleaseObjects('nope', 'team-a')).rejects.toMatchObject({
            kind: 'notFound',
            op: 'releases.resources',
        });
    });

    it('answers no objects for a revision that rendered none', async () => {
        core.listNamespacedSecret.mockResolvedValue({ items: [releaseSecret({ ...current, manifest: '' })] });
        await expect(helmObjects.getReleaseObjects('web', 'team-a')).resolves.toEqual([]);
        expect(objects.list).not.toHaveBeenCalled();
    });
});
