import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ApiException, type V1Secret } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipOf } from './chart-archive-fixture';

const objects = { create: vi.fn(), read: vi.fn(), delete: vi.fn(), replace: vi.fn(), patch: vi.fn() };
const core = {
    listNamespacedSecret: vi.fn(),
    createNamespacedSecret: vi.fn(),
    readNamespacedSecret: vi.fn(),
    replaceNamespacedSecret: vi.fn(),
};
const client = {
    apis: () => ({ core, objects }),
    activeContextName: vi.fn<() => string>(() => 'alpha'),
    getActiveNamespace: vi.fn<() => string | null>(() => 'team-a'),
    listItems: vi.fn(),
};
vi.mock('../../../src/main/k8s/client.js', () => client);

const fetchMod = { fetchChart: vi.fn() };
vi.mock('../../../src/main/charts/fetch.js', () => fetchMod);

const renderMod = { renderChart: vi.fn() };
vi.mock('../../../src/main/charts/render.js', () => renderMod);

const capabilitiesMod = { clusterCapabilities: vi.fn() };
vi.mock('../../../src/main/k8s/capabilities.js', () => capabilitiesMod);

const { K8sError } = await import('../../../src/main/k8s/errors.js');
const helm = await import('../../../src/main/k8s/resources/helm.js');
const upgrade = await import('../../../src/main/k8s/resources/helm-upgrade.js');

type RenderedHook = import('../../../src/main/charts/render.js').RenderedHook;
type ChartRender = import('../../../src/main/charts/render.js').ChartRender;
type HelmReleaseData = import('../../../src/main/k8s/resources/helm.js').HelmReleaseData;

const apiError = (code: number, message = 'refused') =>
    new ApiException(code, message, { kind: 'Status', message }, {});

type Obj = {
    apiVersion: string;
    kind: string;
    metadata: {
        name: string;
        namespace?: string;
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
        resourceVersion?: string;
        uid?: string;
    };
    data?: Record<string, string>;
    status?: unknown;
};

const configMap = (name: string, data: Record<string, string>, annotations?: Record<string, string>): Obj => ({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name, ...(annotations ? { annotations } : {}) },
    data,
});

function rendered(source: string, object: Obj) {
    return { source, manifest: JSON.stringify(object), object } as unknown as ChartRender['objects'][number];
}

function hook(name: string, events: string[], deletePolicies: string[] = ['hook-succeeded']): RenderedHook {
    const object = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name } };
    return { ...rendered(`demo/templates/${name}.yaml`, object as Obj), events, weight: 0, deletePolicies };
}

/** The objects the new chart version renders: one changed, one unchanged, one new; `old` is dropped. */
function chartRender(): ChartRender {
    return {
        crds: [
            rendered('demo/crds/widgets.yaml', {
                apiVersion: 'apiextensions.k8s.io/v1',
                kind: 'CustomResourceDefinition',
                metadata: { name: 'widgets.demo.test' },
            }),
        ],
        objects: [
            rendered('demo/templates/settings.yaml', configMap('web-settings', { greeting: 'hi' })),
            rendered('demo/templates/same.yaml', configMap('web-same', { a: '1' })),
            rendered('demo/templates/extra.yaml', configMap('web-extra', { new: 'yes' })),
        ],
        hooks: [hook('migrate', ['pre-upgrade']), hook('notify', ['post-upgrade']), hook('seed', ['pre-install'])],
        manifest: '---\n# Source: demo/templates/settings.yaml\nkind: ConfigMap\n',
        usesLookup: false,
    };
}

/** What revision 2 of the release rendered, which the upgrade starts from. */
const PREVIOUS_MANIFEST = [
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web-settings\ndata:\n  greeting: hello\n',
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web-same\ndata:\n  a: "1"\n',
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web-old\ndata:\n  gone: soon\n',
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web-kept\n  annotations:\n    helm.sh/resource-policy: keep\n',
].join('---\n');

function archiveFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'km-upgrade-'));
    const file = join(dir, 'demo.tgz');
    writeFileSync(
        file,
        gzipOf([
            { name: 'demo/Chart.yaml', body: 'apiVersion: v2\nname: demo\nversion: 0.2.0\n' },
            { name: 'demo/values.yaml', body: 'greeting: hi\n' },
        ]),
    );
    return file;
}

const INPUT = {
    context: 'alpha',
    source: 'fixture',
    chart: 'demo',
    version: '0.2.0',
    name: 'web',
    namespace: 'team-a',
    values: { greeting: 'hi', replicas: 2 },
};

function revision(version: number, status: string, extra: Partial<HelmReleaseData> = {}): HelmReleaseData {
    return {
        name: 'web',
        namespace: 'team-a',
        version,
        info: {
            status,
            first_deployed: '2026-01-01T00:00:00Z',
            last_deployed: `2026-01-0${version}T00:00:00Z`,
            description: 'Install complete',
            notes: '',
        },
        chart: { metadata: { name: 'demo', version: '0.1.0' } },
        config: { greeting: 'hello' },
        manifest: PREVIOUS_MANIFEST,
        hooks: [],
        ...extra,
    };
}

/** A release Secret as the API hands it back: `data`, base64 over the stored text. */
function stored(data: HelmReleaseData): V1Secret {
    const body = helm.releaseSecretBody(data);
    return {
        ...body,
        metadata: { ...body.metadata, resourceVersion: '1' },
        stringData: undefined,
        data: { release: Buffer.from(body.stringData!.release!, 'utf8').toString('base64') },
    };
}

/** Decode a release Secret body the way Helm's Secret driver reads one. */
function helmReads(body: V1Secret): HelmReleaseData {
    const text = body.stringData?.release ?? Buffer.from(body.data!.release!, 'base64').toString('utf8');
    return JSON.parse(gunzipSync(Buffer.from(text, 'base64')).toString('utf8')) as HelmReleaseData;
}

const OWNED = {
    labels: { 'app.kubernetes.io/managed-by': 'Helm' },
    annotations: { 'meta.helm.sh/release-name': 'web', 'meta.helm.sh/release-namespace': 'team-a' },
};

let secrets: Map<string, V1Secret>;
let cluster: Map<string, Obj>;
/** Who owns each field of each object, as `manager/operation`, which is what server-side apply reads. */
let owners: Map<string, Map<string, string>>;
let log: string[];

const SEP = '\u0000';
/** The fields an apply can own: everything but identity, bookkeeping and status. */
function leaves(object: Obj): Map<string, unknown> {
    const out = new Map<string, unknown>();
    const walk = (value: unknown, path: string[]) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
        } else out.set(path.join(SEP), value);
    };
    const { metadata, apiVersion: _a, kind: _k, status: _s, ...rest } = structuredClone(object);
    walk({ labels: metadata.labels, annotations: metadata.annotations }, ['metadata']);
    walk(rest, []);
    for (const key of [...out.keys()]) if (out.get(key) === undefined) out.delete(key);
    return out;
}

function setPath(object: Record<string, unknown>, path: string, value: unknown): void {
    const keys = path.split(SEP);
    let at = object;
    for (const key of keys.slice(0, -1)) at = (at[key] ??= {}) as Record<string, unknown>;
    at[keys[keys.length - 1]!] = value;
}

function unsetPath(object: Record<string, unknown>, path: string): void {
    const keys = path.split(SEP);
    let at: Record<string, unknown> | undefined = object;
    for (const key of keys.slice(0, -1)) at = at?.[key] as Record<string, unknown> | undefined;
    if (at) delete at[keys[keys.length - 1]!];
}

/** The managed fields a read shows, one entry per manager and operation. */
function managedFields(name: string) {
    const byManager = new Map<string, Record<string, unknown>>();
    for (const [path, owner] of owners.get(name) ?? []) {
        const fields = byManager.get(owner) ?? {};
        setPath(
            fields,
            path
                .split(SEP)
                .map((key) => `f:${key}`)
                .join(SEP),
            {},
        );
        byManager.set(owner, fields);
    }
    return [...byManager].map(([owner, fieldsV1]) => {
        const [manager, operation] = owner.split('/');
        return { manager, operation, apiVersion: 'v1', fieldsType: 'FieldsV1', fieldsV1 };
    });
}

const conflictWith = (conflicts: { field: string; manager: string }[]) =>
    new ApiException(
        409,
        'Conflict',
        {
            kind: 'Status',
            reason: 'Conflict',
            message: `Apply failed with ${conflicts.length} conflict(s)`,
            details: {
                causes: conflicts.map(({ field, manager }) => ({
                    type: 'FieldManagerConflict',
                    message: `conflict with "${manager}" using v1`,
                    field,
                })),
            },
        },
        {},
    );

/** Give one field of a live object to another manager, with the value that manager wrote. */
function ownedBy(name: string, path: string[], value: unknown, owner: string): void {
    setPath(cluster.get(name)! as unknown as Record<string, unknown>, path.join(SEP), value);
    owners.get(name)!.set(path.join(SEP), owner);
}

/** What the cluster holds under a name, as a read of it answers: owned, versioned, with a uid. */
function live(object: Obj): Obj {
    return {
        ...structuredClone(object),
        metadata: {
            ...structuredClone(object.metadata),
            namespace: 'team-a',
            labels: { ...OWNED.labels, ...object.metadata.labels },
            annotations: { ...OWNED.annotations, ...object.metadata.annotations },
            resourceVersion: '10',
            uid: `uid-${object.metadata.name}`,
        },
    };
}

function seed(revisions: HelmReleaseData[]): void {
    for (const one of revisions) {
        const secret = stored(one);
        secrets.set(secret.metadata!.name!, secret);
    }
}

beforeEach(() => {
    upgrade.clearUpgradeReviews();
    for (const mock of [...Object.values(objects), ...Object.values(core)]) mock.mockReset();
    client.activeContextName.mockReturnValue('alpha');
    fetchMod.fetchChart.mockReset().mockResolvedValue({ path: archiveFile(), digest: 'abc', chartYaml: '' });
    renderMod.renderChart.mockReset().mockResolvedValue({ ok: true, render: chartRender() });
    capabilitiesMod.clusterCapabilities.mockReset().mockResolvedValue({ kubeVersion: 'v1.31.0', apiVersions: ['v1'] });
    secrets = new Map();
    cluster = new Map();
    owners = new Map();
    log = [];
    seed([revision(1, 'superseded'), revision(2, 'deployed')]);
    // Installed by Helm 4, which applies server-side, so Helm's apply owns every field it wrote.
    for (const object of helm.manifestObjects(PREVIOUS_MANIFEST, 'team-a')) {
        const held = live(object as Obj);
        cluster.set(object.metadata.name, held);
        owners.set(object.metadata.name, new Map([...leaves(held).keys()].map((path) => [path, 'helm/Apply'])));
    }

    core.listNamespacedSecret.mockImplementation(() => Promise.resolve({ items: [...secrets.values()] }));
    core.createNamespacedSecret.mockImplementation(({ body }: { body: V1Secret }) => {
        const name = body.metadata!.name!;
        if (secrets.has(name)) return Promise.reject(apiError(409));
        log.push(`secret ${name} ${body.metadata!.labels!.status}`);
        secrets.set(name, body);
        return Promise.resolve(body);
    });
    core.readNamespacedSecret.mockImplementation(({ name }: { name: string }) =>
        Promise.resolve({ ...secrets.get(name), metadata: { ...secrets.get(name)!.metadata, resourceVersion: '7' } }),
    );
    core.replaceNamespacedSecret.mockImplementation(({ name, body }: { name: string; body: V1Secret }) => {
        log.push(`secret ${name} ${body.metadata!.labels!.status}`);
        secrets.set(name, body);
        return Promise.resolve(body);
    });

    objects.read.mockImplementation((object: Obj) => {
        const found = cluster.get(object.metadata.name);
        if (!found) return Promise.reject(apiError(404));
        if (object.kind === 'Job')
            return Promise.resolve({ ...found, status: { conditions: [{ type: 'Complete', status: 'True' }] } });
        const read = structuredClone(found);
        return Promise.resolve({
            ...read,
            metadata: { ...read.metadata, managedFields: managedFields(object.metadata.name) },
        });
    });
    // Server-side apply, as the API server does it for the fields modelled here: a field another manager
    // owns with another value is a conflict unless forced, and a field only this manager owned that the
    // applied object leaves out is removed. A merge patch is the ownership move, which rewrites owners.
    objects.patch.mockImplementation(
        (object: Obj, _pretty?: string, dryRun?: string, manager?: string, force?: boolean, strategy?: string) => {
            const name = object.metadata.name;
            const found = cluster.get(name);
            if (strategy === 'application/merge-patch+json') {
                if (!found) return Promise.reject(apiError(404));
                if (object.metadata.resourceVersion !== found.metadata.resourceVersion) {
                    return Promise.reject(apiError(409));
                }
                log.push(`own ${object.kind} ${name}`);
                const own = owners.get(name)!;
                for (const [path, owner] of own) if (owner === 'helm/Update') own.set(path, 'helm/Apply');
                return Promise.resolve(found);
            }
            const me = `${manager}/Apply`;
            const own = new Map(owners.get(name) ?? []);
            const next = (found
                ? structuredClone(found)
                : {
                      apiVersion: object.apiVersion,
                      kind: object.kind,
                      metadata: { name, uid: 'new' },
                  }) as unknown as Record<string, unknown>;
            const wanted = leaves(object);
            const held = found ? leaves(found) : new Map<string, unknown>();
            const conflicts = [...wanted]
                .filter(([path, value]) => {
                    const owner = own.get(path);
                    return owner && owner !== me && held.get(path) !== value;
                })
                .map(([path]) => ({ field: `.${path.split(SEP).join('.')}`, manager: own.get(path)!.split('/')[0]! }));
            if (conflicts.length > 0 && !force) return Promise.reject(conflictWith(conflicts));
            for (const [path, owner] of [...own]) {
                if (owner === me && !wanted.has(path)) {
                    unsetPath(next, path);
                    own.delete(path);
                }
            }
            for (const [path, value] of wanted) {
                setPath(next, path, value);
                own.set(path, me);
            }
            if (!dryRun) {
                log.push(`apply ${object.kind} ${name}`);
                const stored = next as unknown as Obj;
                cluster.set(name, { ...stored, metadata: { ...stored.metadata, resourceVersion: '11' } });
                owners.set(name, own);
            }
            return Promise.resolve(next);
        },
    );
    objects.create.mockImplementation((object: Obj, _pretty?: string, dryRun?: string) => {
        if (cluster.has(object.metadata.name)) return Promise.reject(apiError(409));
        const made = { ...structuredClone(object), metadata: { ...object.metadata, uid: 'new', resourceVersion: '1' } };
        if (!dryRun) {
            log.push(`create ${object.kind} ${object.metadata.name}`);
            cluster.set(object.metadata.name, made);
        }
        return Promise.resolve(made);
    });
    objects.replace.mockImplementation((object: Obj, _pretty?: string, dryRun?: string) => {
        const found = cluster.get(object.metadata.name);
        if (!found) return Promise.reject(apiError(404));
        if (object.metadata.resourceVersion !== found.metadata.resourceVersion) return Promise.reject(apiError(409));
        const next = { ...structuredClone(object), metadata: { ...object.metadata, uid: found.metadata.uid } };
        if (!dryRun) {
            log.push(`replace ${object.kind} ${object.metadata.name}`);
            cluster.set(object.metadata.name, { ...next, metadata: { ...next.metadata, resourceVersion: '11' } });
        }
        return Promise.resolve(next);
    });
    objects.delete.mockImplementation((object: Obj) => {
        owners.delete(object.metadata.name);
        if (!cluster.delete(object.metadata.name)) return Promise.reject(apiError(404));
        log.push(`delete ${object.kind} ${object.metadata.name}`);
        return Promise.resolve({});
    });
});

const secretList = (revisions: HelmReleaseData[]) =>
    revisions.map((data) => ({ secret: stored(data), data })).sort((a, b) => b.data.version! - a.data.version!);

describe('upgradeBase', () => {
    it('starts from the latest revision when it is deployed and numbers the next one after it', () => {
        const base = upgrade.upgradeBase(
            secretList([revision(1, 'superseded'), revision(2, 'deployed')]),
            'web',
            'team-a',
        );
        expect(base.current.data.version).toBe(2);
        expect(base.next).toBe(3);
    });

    it('starts from the deployed revision under a failed one, as Helm does, and still numbers forward', () => {
        const base = upgrade.upgradeBase(secretList([revision(1, 'deployed'), revision(2, 'failed')]), 'web', 'team-a');
        expect(base.current.data.version).toBe(1);
        expect(base.next).toBe(3);
    });

    it('starts from a failed install when nothing was ever deployed', () => {
        const base = upgrade.upgradeBase(secretList([revision(1, 'failed')]), 'web', 'team-a');
        expect(base.current.data.version).toBe(1);
        expect(base.next).toBe(2);
    });

    it('refuses a release another operation holds pending, one uninstalled, and one that does not exist', () => {
        expect(() =>
            upgrade.upgradeBase(secretList([revision(1, 'deployed'), revision(2, 'pending-upgrade')]), 'web', 'team-a'),
        ).toThrow(/another operation .* in progress/);
        expect(() => upgrade.upgradeBase(secretList([revision(1, 'uninstalled')]), 'web', 'team-a')).toThrow(
            /uninstalled/,
        );
        expect(() => upgrade.upgradeBase([], 'web', 'team-a')).toThrow(K8sError);
        try {
            upgrade.upgradeBase([], 'web', 'team-a');
        } catch (error) {
            expect(error).toMatchObject({ kind: 'notFound' });
        }
    });
});

describe('reviewUpgrade', () => {
    it('renders the chart as an upgrade of the release, with the values the editor parsed', async () => {
        await upgrade.reviewUpgrade(INPUT);
        expect(renderMod.renderChart).toHaveBeenCalledWith(
            expect.stringMatching(/demo\.tgz$/),
            INPUT.values,
            { kubeVersion: 'v1.31.0', apiVersions: ['v1'] },
            { name: 'web', namespace: 'team-a', upgrade: true },
        );
    });

    it('says what each object will become, diffing the live object against the dry run’s answer', async () => {
        const outcome = await upgrade.reviewUpgrade(INPUT);
        if (!outcome.rendered) throw new Error('expected a review');
        const { review } = outcome;
        expect(review).toMatchObject({
            name: 'web',
            namespace: 'team-a',
            chart: 'demo',
            version: '0.2.0',
            revision: 3,
            from: { revision: 2, chart: 'demo-0.1.0' },
            skippedCrds: 1,
            usesLookup: false,
        });
        const byName = Object.fromEntries(review.objects.map((one) => [one.name, one]));
        expect(byName['web-settings']).toMatchObject({ change: 'update', check: { state: 'passed' } });
        expect(byName['web-settings']!.live).toContain('greeting: hello');
        expect(byName['web-settings']!.next).toContain('greeting: hi');
        expect(byName['web-same']).toMatchObject({ change: 'unchanged', check: { state: 'passed' } });
        expect(byName['web-same']!.live).toBe(byName['web-same']!.next);
        expect(byName['web-extra']).toMatchObject({ change: 'create', live: '', check: { state: 'passed' } });
        // The server owns the identity and the version; neither is a change anybody made.
        for (const one of review.objects) {
            expect(one.live).not.toMatch(/uid:|resourceVersion:/);
            expect(one.next).not.toMatch(/uid:|resourceVersion:/);
        }
    });

    it('dry-runs the apply the upgrade sends: Helm’s manager, Helm’s ownership, no force', async () => {
        await upgrade.reviewUpgrade(INPUT);
        const applied = objects.patch.mock.calls.filter(
            ([, , , , , strategy]) => strategy === 'application/apply-patch+yaml',
        );
        expect(applied.map(([one]) => (one as Obj).metadata.name)).toEqual(['web-settings', 'web-same', 'web-extra']);
        for (const [sent, pretty, dryRun, manager, force] of applied) {
            expect([pretty, dryRun, manager, force]).toEqual([undefined, 'All', 'helm', false]);
            // The whole object as rendered, stamped, and with no version: an apply is not a replace.
            expect(sent).toMatchObject({ metadata: { namespace: 'team-a', ...OWNED } });
            expect((sent as Obj).metadata.resourceVersion).toBeUndefined();
        }
        expect(objects.replace).not.toHaveBeenCalled();
        // An upgrade installs no CRDs, so none is checked.
        expect(objects.create.mock.calls.some(([one]) => (one as Obj).kind === 'CustomResourceDefinition')).toBe(false);
        expect(log).toEqual([]);
    });

    it('keeps in the diff what another manager owns, and shows a field Helm alone set going', async () => {
        // An autoscaler's replicas, in miniature: a field the chart does not render, owned elsewhere.
        ownedBy('web-settings', ['data', 'scaledBy'], 'hpa', 'kube-controller-manager/Update');
        // A field the previous revision rendered and this one does not, which only Helm owns.
        ownedBy('web-same', ['data', 'dropped'], 'soon', 'helm/Apply');
        const outcome = await upgrade.reviewUpgrade(INPUT);
        if (!outcome.rendered) throw new Error('expected a review');
        const byName = Object.fromEntries(outcome.review.objects.map((one) => [one.name, one]));
        expect(byName['web-settings']!.next).toContain('scaledBy: hpa');
        expect(byName['web-same']).toMatchObject({ change: 'update' });
        expect(byName['web-same']!.live).toContain('dropped: soon');
        expect(byName['web-same']!.next).not.toContain('dropped');
    });

    it('refuses a field another manager set to another value, naming the field and the manager', async () => {
        ownedBy('web-settings', ['data', 'greeting'], 'edited by hand', 'kubectl-edit/Update');
        const outcome = await upgrade.reviewUpgrade(INPUT);
        if (!outcome.rendered) throw new Error('expected a review');
        const settings = outcome.review.objects.find((one) => one.name === 'web-settings')!;
        expect(settings.check).toEqual({
            state: 'failed',
            message: expect.stringMatching(
                /^ConfigMap "web-settings" in team-a: \.data\.greeting is managed by "kubectl-edit"\./,
            ),
        });
        expect(settings.live).toContain('edited by hand');
    });

    it('reviews a release Helm wrote client-side as its own, past conflicts with nobody but Helm', async () => {
        // Helm 3, or Helm 4 with --server-side=false: every field is Helm's, through an update.
        for (const own of owners.values()) for (const path of own.keys()) own.set(path, 'helm/Update');
        const outcome = await upgrade.reviewUpgrade(INPUT);
        if (!outcome.rendered) throw new Error('expected a review');
        expect(outcome.review.objects.find((one) => one.name === 'web-settings')).toMatchObject({
            change: 'update',
            check: { state: 'passed' },
        });
        expect(log).toEqual([]);
    });

    it('lists what the new revision drops, the kept ones and those already gone included', async () => {
        cluster.delete('web-kept');
        const outcome = await upgrade.reviewUpgrade(INPUT);
        if (!outcome.rendered) throw new Error('expected a review');
        expect(outcome.review.removed).toEqual([
            expect.objectContaining({ kind: 'ConfigMap', name: 'web-old', namespace: 'team-a', kept: false }),
            expect.objectContaining({ kind: 'ConfigMap', name: 'web-kept', kept: true, live: null }),
        ]);
        expect(outcome.review.removed[0]!.live).toContain('gone: soon');
    });

    it('refuses to adopt an object already there that this release neither rendered nor owns, as Helm does', async () => {
        cluster.set('web-extra', {
            ...configMap('web-extra', { mine: 'yes' }),
            metadata: { name: 'web-extra', resourceVersion: '3' },
        });
        const outcome = await upgrade.reviewUpgrade(INPUT);
        if (!outcome.rendered) throw new Error('expected a review');
        const extra = outcome.review.objects.find((one) => one.name === 'web-extra')!;
        expect(extra.check).toEqual({
            state: 'failed',
            message: expect.stringMatching(/ConfigMap "web-extra" in team-a exists and is not owned by release "web"/),
        });
        expect(extra.change).toBe('update');
    });

    it('adopts an object already there when it carries this release’s ownership', async () => {
        cluster.set('web-extra', live(configMap('web-extra', { new: 'yes' })));
        const outcome = await upgrade.reviewUpgrade(INPUT);
        if (!outcome.rendered) throw new Error('expected a review');
        expect(outcome.review.objects.find((one) => one.name === 'web-extra')).toMatchObject({
            change: 'unchanged',
            check: { state: 'passed' },
        });
    });

    it('carries a refusal of the dry run onto its object, with the rendered object in place of an answer', async () => {
        objects.patch.mockImplementation((object: Obj) =>
            object.metadata.name === 'web-settings'
                ? Promise.reject(apiError(422, 'ConfigMap "web-settings" is invalid: data: Invalid value'))
                : Promise.resolve(object),
        );
        const outcome = await upgrade.reviewUpgrade(INPUT);
        if (!outcome.rendered) throw new Error('expected a review');
        const settings = outcome.review.objects.find((one) => one.name === 'web-settings')!;
        expect(settings.check).toMatchObject({ state: 'failed', message: expect.stringContaining('Invalid value') });
        expect(settings.next).toContain('greeting: hi');
    });

    it('writes both sides of the values diff the same way, the release’s own values against the new ones', async () => {
        const outcome = await upgrade.reviewUpgrade(INPUT);
        if (!outcome.rendered) throw new Error('expected a review');
        expect(outcome.review.previousValues).toBe('greeting: hello\n');
        expect(outcome.review.values).toBe('greeting: hi\nreplicas: 2\n');
    });

    it('answers Helm’s refusal for the values editor rather than failing', async () => {
        renderMod.renderChart.mockResolvedValue({ ok: false, error: { reason: 'template', message: 'no host' } });
        await expect(upgrade.reviewUpgrade(INPUT)).resolves.toEqual({
            rendered: false,
            reason: 'template',
            message: 'no host',
        });
    });

    it('refuses a release that is not there, or is mid-operation, before anything renders', async () => {
        secrets.clear();
        await expect(upgrade.reviewUpgrade(INPUT)).rejects.toMatchObject({ kind: 'notFound' });
        seed([revision(1, 'deployed'), revision(2, 'pending-rollback')]);
        await expect(upgrade.reviewUpgrade(INPUT)).rejects.toMatchObject({ kind: 'conflict' });
        expect(renderMod.renderChart).not.toHaveBeenCalled();
    });

    it('refuses a review whose context changed while Helm rendered it', async () => {
        renderMod.renderChart.mockImplementation(() => {
            client.activeContextName.mockReturnValue('beta');
            return Promise.resolve({ ok: true, render: chartRender() });
        });
        await expect(upgrade.reviewUpgrade(INPUT)).rejects.toMatchObject({ kind: 'conflict' });
    });
});

async function reviewed() {
    const outcome = await upgrade.reviewUpgrade(INPUT);
    if (!outcome.rendered) throw new Error('expected a review');
    return outcome.review;
}

describe('upgradeRelease', () => {
    it('writes in Helm’s order and records the new revision deployed over a superseded one', async () => {
        const review = await reviewed();
        objects.patch.mockClear();
        const result = await upgrade.upgradeRelease({ context: 'alpha', reviewId: review.reviewId });
        expect(result).toEqual({ name: 'web', namespace: 'team-a', revision: 3, status: 'deployed', message: null });
        expect(log).toEqual([
            'secret sh.helm.release.v1.web.v3 pending-upgrade',
            'create Job migrate',
            'delete Job migrate',
            // Every rendered object is applied, the unchanged one too, as Helm applies them all.
            'apply ConfigMap web-settings',
            'apply ConfigMap web-same',
            'apply ConfigMap web-extra',
            'delete ConfigMap web-old',
            'create Job notify',
            'delete Job notify',
            'secret sh.helm.release.v1.web.v2 superseded',
            'secret sh.helm.release.v1.web.v3 deployed',
        ]);
        for (const call of objects.patch.mock.calls)
            expect(call.slice(2)).toEqual([undefined, 'helm', false, 'application/apply-patch+yaml']);
        // Kept by the chart's own annotation, and left where it is.
        expect(cluster.has('web-kept')).toBe(true);
        // Every object carries the ownership Helm checks before it will touch one.
        expect(cluster.get('web-extra')).toMatchObject({ metadata: OWNED });
        expect(cluster.get('web-settings')).toMatchObject({ metadata: OWNED, data: { greeting: 'hi' } });
    });

    it('keeps what another manager set and removes what Helm alone set and the render dropped', async () => {
        ownedBy('web-settings', ['data', 'scaledBy'], 'hpa', 'kube-controller-manager/Update');
        ownedBy('web-settings', ['metadata', 'annotations', 'tool.example/seen'], 'yes', 'kubectl-annotate/Update');
        ownedBy('web-same', ['data', 'dropped'], 'soon', 'helm/Apply');
        const review = await reviewed();
        await upgrade.upgradeRelease({ context: 'alpha', reviewId: review.reviewId });
        expect(cluster.get('web-settings')!.data).toEqual({ greeting: 'hi', scaledBy: 'hpa' });
        expect(cluster.get('web-settings')!.metadata.annotations).toMatchObject({ 'tool.example/seen': 'yes' });
        expect(cluster.get('web-same')!.data).toEqual({ a: '1' });
    });

    it('moves Helm’s client-side ownership onto its apply before applying, so Helm’s dropped fields go', async () => {
        for (const own of owners.values()) for (const path of own.keys()) own.set(path, 'helm/Update');
        ownedBy('web-same', ['data', 'dropped'], 'soon', 'helm/Update');
        const review = await reviewed();
        const result = await upgrade.upgradeRelease({ context: 'alpha', reviewId: review.reviewId });
        expect(result.status).toBe('deployed');
        expect(log.indexOf('own ConfigMap web-settings')).toBe(log.indexOf('apply ConfigMap web-settings') - 1);
        const [moved, , , , , strategy] = objects.patch.mock.calls.find(
            ([one, , , , , how]) =>
                (one as Obj).metadata.name === 'web-settings' && how === 'application/merge-patch+json',
        )!;
        expect(strategy).toBe('application/merge-patch+json');
        // Conditional on the version it read, with Helm's update entry folded into its apply entry.
        expect(moved).toMatchObject({ metadata: { name: 'web-settings', resourceVersion: '10' } });
        const entries = (moved as { metadata: { managedFields: { manager: string; operation: string }[] } }).metadata
            .managedFields;
        expect(entries.map((one) => `${one.manager}/${one.operation}`)).toEqual(['helm/Apply']);
        expect(cluster.get('web-same')!.data).toEqual({ a: '1' });
    });

    it('fails the upgrade on a conflict that arose after the review, naming the field and its manager', async () => {
        const review = await reviewed();
        ownedBy('web-settings', ['data', 'greeting'], 'edited by hand', 'kubectl-edit/Update');
        const result = await upgrade.upgradeRelease({ context: 'alpha', reviewId: review.reviewId });
        expect(result).toMatchObject({
            status: 'failed',
            message: expect.stringContaining('.data.greeting is managed by "kubectl-edit"'),
        });
        expect(cluster.get('web-settings')!.data!.greeting).toBe('edited by hand');
        expect(helmReads(secrets.get('sh.helm.release.v1.web.v2')!).info!.status).toBe('deployed');
    });

    it('records what the Helm CLI reads: the chart, the values, the render and the hooks it ran', async () => {
        const review = await reviewed();
        await upgrade.upgradeRelease({ context: 'alpha', reviewId: review.reviewId });
        const next = helmReads(secrets.get('sh.helm.release.v1.web.v3')!);
        expect(next).toMatchObject({
            name: 'web',
            namespace: 'team-a',
            version: 3,
            info: {
                status: 'deployed',
                description: 'Upgrade complete',
                first_deployed: '2026-01-01T00:00:00Z',
            },
            chart: { metadata: { name: 'demo', version: '0.2.0' } },
            config: INPUT.values,
            manifest: chartRender().manifest,
            apply_method: 'ssa',
        });
        expect(next.info!.last_deployed).not.toBe('2026-01-02T00:00:00Z');
        expect(next.hooks!.map((one) => [one.name, one.last_run?.phase])).toEqual([
            ['migrate', 'Succeeded'],
            ['notify', 'Succeeded'],
            ['seed', undefined],
        ]);
        expect(secrets.get('sh.helm.release.v1.web.v3')!.metadata!.labels).toMatchObject({
            name: 'web',
            owner: 'helm',
            status: 'deployed',
            version: '3',
        });
        const previous = helmReads(secrets.get('sh.helm.release.v1.web.v2')!);
        expect(previous.info!.status).toBe('superseded');
        expect(previous.manifest).toBe(PREVIOUS_MANIFEST);
    });

    it('marks the new revision failed when a hook fails, leaving the previous one deployed', async () => {
        const review = await reviewed();
        objects.read.mockImplementation((object: Obj) => {
            const found = cluster.get(object.metadata.name);
            if (!found) return Promise.reject(apiError(404));
            if (object.metadata.name === 'migrate') {
                return Promise.resolve({
                    ...found,
                    status: { conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] },
                });
            }
            return Promise.resolve(structuredClone(found));
        });
        const result = await upgrade.upgradeRelease({ context: 'alpha', reviewId: review.reviewId });
        expect(result).toMatchObject({
            revision: 3,
            status: 'failed',
            message: expect.stringContaining('BackoffLimitExceeded'),
        });
        const next = helmReads(secrets.get('sh.helm.release.v1.web.v3')!);
        expect(next.info).toMatchObject({
            status: 'failed',
            description: expect.stringMatching(/^Upgrade "web" failed: /),
        });
        expect(helmReads(secrets.get('sh.helm.release.v1.web.v2')!).info!.status).toBe('deployed');
        // Nothing past the hook was written.
        expect(log.some((line) => line.startsWith('replace ConfigMap'))).toBe(false);
    });

    it('marks the new revision failed when an object is refused part-way', async () => {
        const review = await reviewed();
        objects.patch.mockRejectedValue(apiError(422, 'ConfigMap "web-settings" is invalid'));
        const result = await upgrade.upgradeRelease({ context: 'alpha', reviewId: review.reviewId });
        expect(result.status).toBe('failed');
        expect(helmReads(secrets.get('sh.helm.release.v1.web.v3')!).info!.status).toBe('failed');
    });

    it('spends a review on one upgrade and refuses one that is unknown or expired', async () => {
        const review = await reviewed();
        await upgrade.upgradeRelease({ context: 'alpha', reviewId: review.reviewId });
        await expect(upgrade.upgradeRelease({ context: 'alpha', reviewId: review.reviewId })).rejects.toMatchObject({
            kind: 'invalid',
        });
        await expect(upgrade.upgradeRelease({ context: 'alpha', reviewId: 'nope' })).rejects.toThrow(/expired/);

        vi.useFakeTimers();
        try {
            const late = await reviewed();
            vi.advanceTimersByTime(31 * 60 * 1000);
            await expect(upgrade.upgradeRelease({ context: 'alpha', reviewId: late.reviewId })).rejects.toThrow(
                /expired/,
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('refuses a review rendered for another context, and one its dry run refused, writing nothing', async () => {
        const review = await reviewed();
        client.activeContextName.mockReturnValue('beta');
        await expect(upgrade.upgradeRelease({ context: 'beta', reviewId: review.reviewId })).rejects.toMatchObject({
            kind: 'conflict',
        });
        client.activeContextName.mockReturnValue('alpha');

        cluster.set('web-extra', {
            ...configMap('web-extra', {}),
            metadata: { name: 'web-extra', resourceVersion: '3' },
        });
        const refused = await reviewed();
        await expect(upgrade.upgradeRelease({ context: 'alpha', reviewId: refused.reviewId })).rejects.toThrow(
            /The dry run refused ConfigMap "web-extra"/,
        );
        expect(log).toEqual([]);
    });

    it('refuses a review once the release has moved on under it, writing nothing', async () => {
        const review = await reviewed();
        seed([revision(3, 'deployed')]);
        await expect(upgrade.upgradeRelease({ context: 'alpha', reviewId: review.reviewId })).rejects.toMatchObject({
            kind: 'conflict',
            detail: expect.stringContaining('changed since it was reviewed'),
        });
        expect(log).toEqual([]);
    });

    it('says where the release was left when the context changes mid-upgrade', async () => {
        const review = await reviewed();
        objects.patch.mockImplementation(() => {
            client.activeContextName.mockReturnValue('beta');
            return Promise.reject(apiError(500));
        });
        await expect(upgrade.upgradeRelease({ context: 'alpha', reviewId: review.reviewId })).rejects.toMatchObject({
            kind: 'conflict',
            detail: expect.stringContaining('left pending-upgrade on alpha'),
        });
    });
});
