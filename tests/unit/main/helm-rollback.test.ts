import { gzipSync } from 'node:zlib';
import { ApiException, PatchStrategy, type V1Secret } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = {
    listNamespacedSecret: vi.fn(),
    createNamespacedSecret: vi.fn(),
    replaceNamespacedSecret: vi.fn(),
};
const objects = { create: vi.fn(), read: vi.fn(), replace: vi.fn(), patch: vi.fn(), delete: vi.fn() };
const client = {
    apis: () => ({ core, objects }),
    getActiveNamespace: vi.fn<() => string | null>(() => null),
    activeContextName: vi.fn<() => string>(() => 'alpha'),
    listItems: vi.fn(),
};
vi.mock('../../../src/main/k8s/client.js', () => client);

const helm = await import('../../../src/main/k8s/resources/helm.js');
const { rollbackRelease } = await import('../../../src/main/k8s/resources/helm-rollback.js');

function releaseSecret(release: Record<string, unknown>): V1Secret {
    const gzipped = gzipSync(Buffer.from(JSON.stringify(release), 'utf8')).toString('base64');
    return {
        metadata: {
            name: `sh.helm.release.v1.${String(release.name)}.v${String(release.version)}`,
            namespace: 'team-a',
        },
        type: 'helm.sh/release.v1',
        data: { release: Buffer.from(gzipped, 'utf8').toString('base64') },
    };
}

const decoded = (secret: V1Secret & { stringData?: { release: string } }) =>
    helm.decodeRelease({
        type: 'helm.sh/release.v1',
        data: { release: Buffer.from(secret.stringData!.release).toString('base64') },
    });

const CONFIG_MAP = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: demo-config', 'data:', '  colour: blue'];
const KEPT_SERVICE = [
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    '  name: demo-svc',
    '  annotations:',
    '    helm.sh/resource-policy: keep',
];
const EXTRA = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: extra'];
const manifest = (...docs: string[][]) => docs.map((doc) => doc.join('\n')).join('\n---\n');

const v1 = {
    name: 'demo',
    namespace: 'team-a',
    version: 1,
    info: { status: 'superseded', description: 'Install' },
    manifest: manifest(CONFIG_MAP),
    apply_method: 'csa',
};
const v2 = {
    name: 'demo',
    namespace: 'team-a',
    version: 2,
    info: { status: 'deployed', description: 'Upgrade complete' },
    manifest: manifest(CONFIG_MAP, KEPT_SERVICE),
};
const ON_ALPHA = { context: 'alpha', name: 'demo', namespace: 'team-a' };

const seed = (...releases: Record<string, unknown>[]) =>
    core.listNamespacedSecret.mockResolvedValue({ items: releases.map(releaseSecret) });

const conflict = (field: string, manager: string) =>
    new ApiException(
        409,
        'Conflict',
        {
            kind: 'Status',
            reason: 'Conflict',
            details: {
                causes: [{ reason: 'FieldManagerConflict', message: `conflict with "${manager}"`, field }],
            },
        },
        {},
    );

const isDryRun = (call: unknown[]) => call[2] === 'All';
const applies = () => objects.patch.mock.calls.filter((call) => call[5] === PatchStrategy.ServerSideApply);
const writes = () => applies().filter((call) => !isDryRun(call));

beforeEach(() => {
    vi.clearAllMocks();
    client.activeContextName.mockReturnValue('alpha');
    seed(v1, v2);
    core.createNamespacedSecret.mockResolvedValue({});
    core.replaceNamespacedSecret.mockResolvedValue({});
    objects.read.mockResolvedValue({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { resourceVersion: '7' } });
    objects.patch.mockResolvedValue({});
    objects.delete.mockResolvedValue({});
});

describe('rollbackRelease', () => {
    it('applies the revision server-side as helm, never forcing, and records a new revision', async () => {
        const result = await rollbackRelease({ ...ON_ALPHA, revision: 1 });
        expect(result).toMatchObject({ name: 'demo', revision: 3, removed: 0, kept: 1 });

        // Dry-run first, then the write, each as the apply Helm 4 sends: its own field manager, no force.
        const [dry, write] = applies();
        expect(dry!.slice(1)).toEqual([undefined, 'All', 'helm', false, PatchStrategy.ServerSideApply]);
        expect(write!.slice(1)).toEqual([undefined, undefined, 'helm', false, PatchStrategy.ServerSideApply]);
        expect(write![0]).toMatchObject({
            kind: 'ConfigMap',
            metadata: { name: 'demo-config' },
            data: { colour: 'blue' },
        });
        // A replace would drop every field another manager set, so nothing is created or replaced whole.
        expect(objects.create).not.toHaveBeenCalled();
        expect(objects.replace).not.toHaveBeenCalled();
        // The Service revision 2 added is left alone, because the chart asked for it to be kept.
        expect(objects.delete).not.toHaveBeenCalled();

        const created = core.createNamespacedSecret.mock.calls[0]![0].body;
        expect(created.metadata.name).toBe('sh.helm.release.v1.demo.v3');
        expect(created.metadata.labels).toMatchObject({ owner: 'helm', status: 'deployed', version: '3' });
        expect(decoded(created)).toMatchObject({
            version: 3,
            info: { status: 'deployed', description: 'Rollback to 1' },
            // The target was written client-side; the rollback was not, and a later `helm upgrade` reads this.
            apply_method: 'ssa',
        });
        expect(core.replaceNamespacedSecret.mock.calls[0]![0].body.metadata.labels.status).toBe('superseded');
    });

    it('supersedes every deployed revision, as a failed upgrade leaves the one under it deployed', async () => {
        const v3 = {
            ...v2,
            version: 3,
            info: { status: 'failed', description: 'Upgrade "demo" failed: refused' },
        };
        seed(v1, v2, v3);
        const result = await rollbackRelease({ ...ON_ALPHA, revision: 1 });
        expect(result.revision).toBe(4);
        const restatused = core.replaceNamespacedSecret.mock.calls.map(([call]) => [
            call.name,
            call.body.metadata.labels.status,
        ]);
        // The failed current revision and the deployed one under it are superseded; revision 1 already was.
        expect(restatused).toEqual([
            ['sh.helm.release.v1.demo.v3', 'superseded'],
            ['sh.helm.release.v1.demo.v2', 'superseded'],
        ]);
    });

    it('stamps Helm ownership on what it applies, and stores the render without it', async () => {
        await rollbackRelease({ ...ON_ALPHA, revision: 1 });
        // Helm 4.3's uninstall leaves an object without this metadata behind as not its own.
        expect(writes()[0]![0].metadata).toEqual(
            expect.objectContaining({
                labels: expect.objectContaining({ 'app.kubernetes.io/managed-by': 'Helm' }),
                annotations: expect.objectContaining({
                    'meta.helm.sh/release-name': 'demo',
                    'meta.helm.sh/release-namespace': 'team-a',
                }),
            }),
        );
        expect(decoded(core.createNamespacedSecret.mock.calls[0]![0].body)?.manifest).toBe(v1.manifest);
    });

    it('applies an object the cluster no longer holds, which is how it comes back', async () => {
        objects.read.mockRejectedValue(new ApiException(404, 'NotFound', null, {}));
        await rollbackRelease({ ...ON_ALPHA, revision: 1 });
        expect(writes()).toHaveLength(1);
        expect(objects.create).not.toHaveBeenCalled();
    });

    it("moves Helm's client-side ownership onto its apply entry before applying", async () => {
        const live = {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: {
                name: 'demo-config',
                namespace: 'team-a',
                resourceVersion: '7',
                managedFields: [
                    { manager: 'helm', operation: 'Update', fieldsType: 'FieldsV1', fieldsV1: { 'f:data': {} } },
                ],
            },
        };
        objects.read.mockResolvedValue(live);
        // Helm 3 wrote the object, so the dry run meets Helm's own client-side entry and is forced past it.
        objects.patch.mockRejectedValueOnce(conflict('.data.colour', 'helm'));

        await rollbackRelease({ ...ON_ALPHA, revision: 1 });

        const calls = objects.patch.mock.calls;
        expect(calls[1]!.slice(2, 5)).toEqual(['All', 'helm', true]);
        const move = calls.findIndex((call) => call[5] === PatchStrategy.MergePatch);
        expect(calls[move]![0].metadata).toMatchObject({
            resourceVersion: '7',
            managedFields: [expect.objectContaining({ manager: 'helm', operation: 'Apply' })],
        });
        const write = calls.findIndex((call) => call[5] === PatchStrategy.ServerSideApply && !isDryRun(call));
        expect(move).toBeLessThan(write);
        expect(calls[write]![4]).toBe(false);
    });

    it('refuses a field another manager owns before writing anything, naming the field and its manager', async () => {
        seed(v1, { ...v2, manifest: manifest(CONFIG_MAP, EXTRA) });
        objects.patch.mockRejectedValueOnce(conflict('.data.colour', 'kubectl-edit'));

        await expect(rollbackRelease({ ...ON_ALPHA, revision: 1 })).rejects.toMatchObject({
            kind: 'conflict',
            op: 'releases.rollback',
            detail: expect.stringContaining(
                'ConfigMap "demo-config" in team-a: .data.colour is managed by "kubectl-edit"',
            ),
        });
        expect(writes()).toHaveLength(0);
        expect(objects.delete).not.toHaveBeenCalled();
        expect(core.createNamespacedSecret).not.toHaveBeenCalled();
        expect(core.replaceNamespacedSecret).not.toHaveBeenCalled();
    });

    it('does not force past a conflict with helm when Helm holds nothing client-side', async () => {
        objects.patch.mockRejectedValueOnce(conflict('.data.colour', 'helm'));
        await expect(rollbackRelease({ ...ON_ALPHA, revision: 1 })).rejects.toMatchObject({ kind: 'conflict' });
        expect(objects.patch).toHaveBeenCalledTimes(1);
    });

    it('reports a conflict the write meets after the dry run passed, and records no revision', async () => {
        objects.patch.mockResolvedValueOnce({}).mockRejectedValueOnce(conflict('.data.colour', 'kubectl-edit'));
        await expect(rollbackRelease({ ...ON_ALPHA, revision: 1 })).rejects.toMatchObject({
            kind: 'conflict',
            detail: expect.stringContaining('.data.colour is managed by "kubectl-edit"'),
        });
        expect(core.createNamespacedSecret).not.toHaveBeenCalled();
    });

    it('writes nothing when the dry run refuses an object for another reason', async () => {
        objects.patch.mockRejectedValueOnce(new ApiException(422, 'Invalid', { kind: 'Status', code: 422 }, {}));
        await expect(rollbackRelease({ ...ON_ALPHA, revision: 1 })).rejects.toBeDefined();
        expect(writes()).toHaveLength(0);
        expect(core.createNamespacedSecret).not.toHaveBeenCalled();
    });

    it('removes an object the target revision never rendered', async () => {
        seed(v1, { ...v2, manifest: manifest(CONFIG_MAP, EXTRA) });
        const result = await rollbackRelease({ ...ON_ALPHA, revision: 1 });
        expect(objects.delete).toHaveBeenCalledWith(
            expect.objectContaining({ metadata: expect.objectContaining({ name: 'extra' }) }),
        );
        expect(result).toMatchObject({ removed: 1, kept: 0 });
    });

    it('refuses a revision the release never had, and the one it already runs', async () => {
        await expect(rollbackRelease({ ...ON_ALPHA, revision: 9 })).rejects.toMatchObject({
            kind: 'notFound',
            detail: expect.stringContaining('no revision 9'),
        });
        await expect(rollbackRelease({ ...ON_ALPHA, revision: 2 })).rejects.toMatchObject({
            kind: 'invalid',
            detail: expect.stringContaining('already runs revision 2'),
        });
        expect(core.createNamespacedSecret).not.toHaveBeenCalled();
    });

    it('refuses a release that is not there, and one aimed at another context', async () => {
        seed();
        await expect(rollbackRelease({ ...ON_ALPHA, revision: 1 })).rejects.toMatchObject({ kind: 'notFound' });
        client.activeContextName.mockReturnValue('beta');
        seed(v1, v2);
        await expect(rollbackRelease({ ...ON_ALPHA, revision: 1 })).rejects.toMatchObject({ kind: 'conflict' });
        expect(objects.patch).not.toHaveBeenCalled();
    });
});
