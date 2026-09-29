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
};
vi.mock('../../../src/main/k8s/client.js', () => client);

const fetchMod = { fetchChart: vi.fn() };
vi.mock('../../../src/main/charts/fetch.js', () => fetchMod);

const renderMod = { renderChart: vi.fn() };
vi.mock('../../../src/main/charts/render.js', () => renderMod);

const capabilitiesMod = { clusterCapabilities: vi.fn() };
vi.mock('../../../src/main/k8s/capabilities.js', () => capabilitiesMod);

const { K8sError } = await import('../../../src/main/k8s/errors.js');
const { reviewProblem } = await import('../../../src/shared/chart-install.js');
const install = await import('../../../src/main/k8s/resources/helm-install.js');

type RenderedHook = import('../../../src/main/charts/render.js').RenderedHook;
type ChartRender = import('../../../src/main/charts/render.js').ChartRender;

const apiError = (code: number, message = 'refused') =>
    new ApiException(code, message, { kind: 'Status', message }, {});

function manifestOf(object: Record<string, unknown>) {
    return JSON.stringify(object);
}

function rendered(source: string, object: Record<string, unknown>) {
    return { source, manifest: manifestOf(object), object } as ChartRender['objects'][number];
}

function hook(name: string, events: string[], weight: number, deletePolicies: string[], kind = 'Job'): RenderedHook {
    const object = { apiVersion: kind === 'Job' ? 'batch/v1' : 'v1', kind, metadata: { name } };
    return { ...rendered(`demo/templates/${name}.yaml`, object), events, weight, deletePolicies };
}

const CRD = {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: { name: 'widgets.demo.test' },
    spec: { group: 'demo.test', names: { kind: 'Widget' } },
};

function chartRender(): ChartRender {
    const objects = [
        rendered('demo/templates/configmap.yaml', { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'web' } }),
        rendered('demo/templates/role.yaml', {
            apiVersion: 'rbac.authorization.k8s.io/v1',
            kind: 'ClusterRole',
            metadata: { name: 'web-reader' },
        }),
        rendered('demo/templates/widget.yaml', { apiVersion: 'demo.test/v1', kind: 'Widget', metadata: { name: 'w' } }),
    ];
    return {
        crds: [rendered('demo/crds/widgets.yaml', CRD)],
        objects,
        hooks: [
            hook('post', ['post-install'], 0, []),
            hook('migrate', ['pre-install', 'pre-upgrade'], 5, ['hook-succeeded']),
            hook('seed', ['pre-install'], -1, ['before-hook-creation', 'hook-succeeded']),
            hook('test', ['test'], 0, []),
        ],
        manifest: '---\n# Source: demo/templates/configmap.yaml\nkind: ConfigMap\n',
        usesLookup: true,
    };
}

function archiveFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'km-install-'));
    const file = join(dir, 'demo.tgz');
    writeFileSync(
        file,
        gzipOf([
            { name: 'demo/Chart.yaml', body: 'apiVersion: v2\nname: demo\nversion: 0.1.0\nappVersion: "1.10"\n' },
            { name: 'demo/values.yaml', body: 'enabled: true\n' },
            { name: 'demo/templates/configmap.yaml', body: 'kind: ConfigMap\n' },
        ]),
    );
    return file;
}

const INPUT = {
    context: 'alpha',
    source: 'fixture',
    chart: 'demo',
    version: '0.1.0',
    name: 'web',
    namespace: 'team-a',
    // The user's overrides as the editor read them: a `yes` typed there is YAML 1.2's string.
    values: { enabled: 'yes', replicas: 2 },
};

/** Decode a release Secret body the way Helm's Secret driver reads one: base64, then gzip, then JSON. */
function helmReads(body: V1Secret): Record<string, unknown> {
    const stored = body.stringData?.release ?? Buffer.from(body.data!.release!, 'base64').toString('utf8');
    return JSON.parse(gunzipSync(Buffer.from(stored, 'base64')).toString('utf8')) as Record<string, unknown>;
}

let secret: V1Secret | null;
type Named = { kind: string; metadata: { name: string } };
const cluster = new Set<string>();

beforeEach(() => {
    install.clearReviews();
    for (const mock of [...Object.values(objects), ...Object.values(core)]) mock.mockReset();
    client.activeContextName.mockReturnValue('alpha');
    fetchMod.fetchChart.mockReset().mockResolvedValue({ path: archiveFile(), digest: 'abc', chartYaml: '' });
    renderMod.renderChart.mockReset().mockResolvedValue({ ok: true, render: chartRender() });
    capabilitiesMod.clusterCapabilities.mockReset().mockResolvedValue({ kubeVersion: 'v1.31.0', apiVersions: ['v1'] });
    core.listNamespacedSecret.mockResolvedValue({ items: [] });
    secret = null;
    cluster.clear();
    // A small cluster: what is created is there to read until it is deleted, a CRD is served at once
    // and a Job has completed by the time it is read.
    objects.create.mockImplementation((object: Named, _pretty?: string, dryRun?: string) => {
        if (!dryRun) cluster.add(object.metadata.name);
        return Promise.resolve({});
    });
    // An apply of an object nobody has yet is a create, so it answers as the create a test set up does.
    objects.patch.mockImplementation((object: Named, pretty?: string, dryRun?: string) =>
        objects.create.getMockImplementation()!(object, pretty, dryRun),
    );
    objects.read.mockImplementation((object: Named) => {
        if (!cluster.has(object.metadata.name)) return Promise.reject(apiError(404));
        if (object.kind === 'CustomResourceDefinition') {
            return Promise.resolve({ status: { conditions: [{ type: 'Established', status: 'True' }] } });
        }
        return Promise.resolve({ kind: object.kind, status: { conditions: [{ type: 'Complete', status: 'True' }] } });
    });
    objects.delete.mockImplementation((object: Named) => {
        if (!cluster.delete(object.metadata.name)) return Promise.reject(apiError(404));
        return Promise.resolve({});
    });
    core.createNamespacedSecret.mockImplementation(({ body }: { body: V1Secret }) => {
        secret = body;
        return Promise.resolve(body);
    });
    core.readNamespacedSecret.mockImplementation(() =>
        Promise.resolve({ ...secret, metadata: { ...secret!.metadata, resourceVersion: '7' } }),
    );
    core.replaceNamespacedSecret.mockImplementation(({ body }: { body: V1Secret }) => {
        secret = body;
        return Promise.resolve(body);
    });
});

describe('hook order and policies', () => {
    it('runs an event’s hooks by weight, then by name, and applies before-hook-creation when none is written', () => {
        const hooks = chartRender().hooks;
        expect(install.hooksFor(hooks, 'pre-install').map((one) => one.object.metadata.name)).toEqual([
            'seed',
            'migrate',
        ]);
        expect(install.hooksFor(hooks, 'post-install').map((one) => one.object.metadata.name)).toEqual(['post']);
        expect(install.effectiveDeletePolicies({ deletePolicies: [] })).toEqual(['before-hook-creation']);
        expect(install.effectiveDeletePolicies({ deletePolicies: ['hook-failed'] })).toEqual(['hook-failed']);
    });

    it('reads a Job and a Pod as finished only once they have, and any other kind at once', () => {
        const job = (conditions: unknown[]) => ({ kind: 'Job', status: { conditions } });
        expect(install.hookProgress(job([]))).toEqual({ done: false });
        expect(install.hookProgress(job([{ type: 'Complete', status: 'True' }]))).toEqual({ done: true, failed: null });
        expect(install.hookProgress(job([{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }]))).toEqual(
            {
                done: true,
                failed: 'job failed: BackoffLimitExceeded',
            },
        );
        expect(install.hookProgress({ kind: 'Pod', status: { phase: 'Running' } })).toEqual({ done: false });
        expect(install.hookProgress({ kind: 'Pod', status: { phase: 'Succeeded' } })).toEqual({
            done: true,
            failed: null,
        });
        expect(install.hookProgress({ kind: 'Pod', status: { phase: 'Failed' } })).toEqual({
            done: true,
            failed: 'pod failed',
        });
        expect(install.hookProgress({ kind: 'ConfigMap' })).toEqual({ done: true, failed: null });
    });
});

describe('reviewChart', () => {
    it('hands Helm the values the editor parsed, unchanged, for the release it names', async () => {
        await install.reviewChart(INPUT);
        expect(renderMod.renderChart).toHaveBeenCalledWith(
            expect.stringMatching(/demo\.tgz$/),
            { enabled: 'yes', replicas: 2 },
            { kubeVersion: 'v1.31.0', apiVersions: ['v1'] },
            { name: 'web', namespace: 'team-a' },
        );
    });

    it('checks every object with a server-side dry run and says what each check found', async () => {
        objects.create.mockImplementation((object: Named, _pretty?: string, dryRun?: string) => {
            expect(dryRun).toBe('All');
            if (object.kind === 'CustomResourceDefinition') return Promise.reject(apiError(409));
            if (object.kind === 'Widget') return Promise.reject(apiError(404));
            if (object.kind === 'ClusterRole')
                return Promise.reject(apiError(409, 'clusterroles "web-reader" already exists'));
            if (object.metadata.name === 'post') return Promise.reject(apiError(409));
            return Promise.resolve({});
        });
        const outcome = await install.reviewChart(INPUT);
        if (!outcome.rendered) throw new Error('expected a review');
        const { review } = outcome;
        expect(review.crds[0]!.check).toMatchObject({ state: 'exists' });
        expect(review.objects.map((one) => [one.kind, one.namespace, one.check.state])).toEqual([
            ['ConfigMap', 'team-a', 'passed'],
            ['ClusterRole', null, 'failed'],
            ['Widget', 'team-a', 'deferred'],
        ]);
        expect(review.objects[1]!.check).toMatchObject({ message: expect.stringContaining('already exists') });
        // Pre-install hooks first by weight, then post-install, then the ones an install only records.
        expect(review.hooks.map((one) => [one.name, one.check.state])).toEqual([
            ['seed', 'passed'],
            ['migrate', 'passed'],
            // Deleted before it is created again, so one already there is no refusal.
            ['post', 'passed'],
            ['test', 'passed'],
        ]);
        expect(review.usesLookup).toBe(true);
        expect(reviewProblem(review)).toMatch(/ClusterRole "web-reader"/);
    });

    it('answers a render Helm refused as an outcome the values editor shows', async () => {
        renderMod.renderChart.mockResolvedValue({
            ok: false,
            error: { reason: 'template', message: 'a host is required' },
        });
        await expect(install.reviewChart(INPUT)).resolves.toEqual({
            rendered: false,
            reason: 'template',
            message: 'a host is required',
        });
        expect(objects.create).not.toHaveBeenCalled();
    });

    it('refuses a release name already recorded in the namespace before rendering anything', async () => {
        core.listNamespacedSecret.mockResolvedValue({ items: [{ metadata: { name: 'sh.helm.release.v1.web.v1' } }] });
        await expect(install.reviewChart(INPUT)).rejects.toMatchObject({ kind: 'conflict' });
        expect(core.listNamespacedSecret).toHaveBeenCalledWith(
            expect.objectContaining({ namespace: 'team-a', labelSelector: 'owner=helm,name=web' }),
        );
        expect(renderMod.renderChart).not.toHaveBeenCalled();
    });

    it('refuses a render meant for another context', async () => {
        client.activeContextName.mockReturnValue('beta');
        await expect(install.reviewChart(INPUT)).rejects.toMatchObject({ kind: 'conflict' });
        expect(fetchMod.fetchChart).not.toHaveBeenCalled();
    });

    it('passes a failed fetch through as the classified failure it is', async () => {
        fetchMod.fetchChart.mockRejectedValue(
            new K8sError('notFound', 'demo 0.1.0 is not in fixture.', 'charts.fetch'),
        );
        await expect(install.reviewChart(INPUT)).rejects.toMatchObject({ kind: 'notFound' });
    });
});

async function reviewed(): Promise<string> {
    const outcome = await install.reviewChart(INPUT);
    if (!outcome.rendered) throw new Error('expected a review');
    objects.create.mockClear();
    objects.patch.mockClear();
    return outcome.review.reviewId;
}

/** Every object written, created or applied, in the order it was written. */
const writes = () =>
    [objects.create, objects.patch]
        .flatMap((mock) => mock.mock.calls.map((call, i) => ({ call, at: mock.mock.invocationCallOrder[i]! })))
        .sort((a, b) => a.at - b.at)
        .map(({ call }) => call);

const createdKinds = () =>
    writes().map(
        ([object]) =>
            `${(object as { kind: string }).kind}/${(object as { metadata: { name: string } }).metadata.name}`,
    );

describe('installRelease', () => {
    it('writes in Helm’s order and records a release the Helm CLI reads back', async () => {
        const reviewId = await reviewed();
        const result = await install.installRelease({ context: 'alpha', reviewId });
        expect(result).toEqual({ name: 'web', namespace: 'team-a', revision: 1, status: 'deployed', message: null });

        expect(createdKinds()).toEqual([
            'CustomResourceDefinition/widgets.demo.test',
            'Job/seed',
            'Job/migrate',
            'ConfigMap/web',
            'ClusterRole/web-reader',
            'Widget/w',
            'Job/post',
        ]);
        // Nothing is a dry run once the install writes.
        for (const call of writes()) expect(call[2]).toBeUndefined();
        // The objects are applied server-side as Helm, never forcing a conflict, as Helm 4 installs them.
        expect(objects.patch.mock.calls.map(([object]) => (object as Named).metadata.name)).toEqual([
            'web',
            'web-reader',
            'w',
        ]);
        for (const call of objects.patch.mock.calls) {
            expect(call.slice(3)).toEqual(['helm', false, 'application/apply-patch+yaml']);
        }
        // The release is recorded before the first hook runs, so a failure after it has a release to mark.
        expect(core.createNamespacedSecret.mock.invocationCallOrder[0]).toBeLessThan(
            objects.create.mock.invocationCallOrder[1]!,
        );
        expect(helmReads(core.createNamespacedSecret.mock.calls[0]![0].body)).toMatchObject({
            info: { status: 'pending-install' },
        });

        const body = secret!;
        expect(body.metadata).toMatchObject({
            name: 'sh.helm.release.v1.web.v1',
            namespace: 'team-a',
            labels: { name: 'web', owner: 'helm', status: 'deployed', version: '1' },
            resourceVersion: '7',
        });
        expect(body.type).toBe('helm.sh/release.v1');
        const release = helmReads(body);
        expect(release).toMatchObject({
            name: 'web',
            namespace: 'team-a',
            version: 1,
            info: { status: 'deployed', description: 'Install complete' },
            chart: { metadata: { name: 'demo', version: '0.1.0', appVersion: '1.10', apiVersion: 'v2' } },
            config: { enabled: 'yes', replicas: 2 },
            manifest: chartRender().manifest,
            apply_method: 'ssa',
        });
        const info = release.info as Record<string, string>;
        expect(Date.parse(info.first_deployed!)).not.toBeNaN();
        const hooks = release.hooks as { name: string; last_run?: { phase: string }; delete_policies: string[] }[];
        expect(hooks.map((one) => [one.name, one.last_run?.phase ?? null])).toEqual([
            ['seed', 'Succeeded'],
            ['migrate', 'Succeeded'],
            ['post', 'Succeeded'],
            ['test', null],
        ]);
        expect(hooks.find((one) => one.name === 'post')!.delete_policies).toEqual(['before-hook-creation']);
        // The hooks that asked to go once they succeeded are deleted; the one that did not is kept.
        const deleted = objects.delete.mock.calls.map(
            ([object]) => (object as { metadata: { name: string } }).metadata.name,
        );
        expect(deleted.filter((name) => name === 'migrate')).toHaveLength(1);
        expect(deleted).toContain('seed');
    });

    it('stamps the objects with the ownership Helm checks before it uninstalls or upgrades them', async () => {
        const reviewId = await reviewed();
        await install.installRelease({ context: 'alpha', reviewId });
        const written = (name: string) =>
            writes()
                .map(([object]) => object as Named & { metadata: { labels?: object; annotations?: object } })
                .find((object) => object.metadata.name === name)!.metadata;
        for (const name of ['web', 'web-reader', 'w']) {
            expect(written(name).labels).toEqual({ 'app.kubernetes.io/managed-by': 'Helm' });
            expect(written(name).annotations).toEqual({
                'meta.helm.sh/release-name': 'web',
                'meta.helm.sh/release-namespace': 'team-a',
            });
        }
        // Helm stamps neither its hooks nor the CRDs, and stores the manifest as rendered.
        expect(written('seed').labels).toBeUndefined();
        expect(written('widgets.demo.test').labels).toBeUndefined();
        expect(helmReads(secret!).manifest).not.toContain('meta.helm.sh');
    });

    it('spends a review, so a second install of it is refused', async () => {
        const reviewId = await reviewed();
        await install.installRelease({ context: 'alpha', reviewId });
        await expect(install.installRelease({ context: 'alpha', reviewId })).rejects.toMatchObject({ kind: 'invalid' });
        await expect(install.installRelease({ context: 'alpha', reviewId: 'unknown' })).rejects.toThrow(/expired/);
    });

    it('refuses a review older than its lifetime, since the cluster may have moved on under it', async () => {
        const reviewId = await reviewed();
        vi.useFakeTimers({ now: Date.now() + install.REVIEW_TTL_MS + 1, toFake: ['Date'] });
        try {
            await expect(install.installRelease({ context: 'alpha', reviewId })).rejects.toThrow(/expired/);
        } finally {
            vi.useRealTimers();
        }
        expect(core.createNamespacedSecret).not.toHaveBeenCalled();
    });

    it('refuses a review whose dry run refused an object, before writing anything', async () => {
        objects.create.mockImplementation((object: { kind: string }) =>
            object.kind === 'ConfigMap' ? Promise.reject(apiError(422, 'data: Invalid value')) : Promise.resolve({}),
        );
        const reviewId = await reviewed();
        await expect(install.installRelease({ context: 'alpha', reviewId })).rejects.toThrow(/data: Invalid value/);
        expect(writes()).toEqual([]);
        expect(core.createNamespacedSecret).not.toHaveBeenCalled();
    });

    it('refuses a review rendered for another context', async () => {
        const reviewId = await reviewed();
        client.activeContextName.mockReturnValue('beta');
        await expect(install.installRelease({ context: 'beta', reviewId })).rejects.toMatchObject({ kind: 'conflict' });
        expect(core.createNamespacedSecret).not.toHaveBeenCalled();
    });

    it('refuses when a release of that name was recorded after the review', async () => {
        const reviewId = await reviewed();
        core.listNamespacedSecret.mockResolvedValue({ items: [{}] });
        await expect(install.installRelease({ context: 'alpha', reviewId })).rejects.toMatchObject({
            kind: 'conflict',
        });
        expect(objects.create).not.toHaveBeenCalled();
    });

    it('records a failure part-way as a failed release rather than leaving the objects unowned', async () => {
        const reviewId = await reviewed();
        objects.create.mockImplementation((object: Named) => {
            if (object.kind === 'ClusterRole') return Promise.reject(apiError(403));
            cluster.add(object.metadata.name);
            return Promise.resolve({});
        });
        const result = await install.installRelease({ context: 'alpha', reviewId });
        expect(result).toMatchObject({ status: 'failed', revision: 1, message: 'Access denied (RBAC).' });
        expect(createdKinds()).not.toContain('Job/post');
        expect(secret!.metadata!.labels!.status).toBe('failed');
        expect(helmReads(secret!)).toMatchObject({
            info: { status: 'failed', description: 'Release "web" failed: Access denied (RBAC).' },
        });
    });

    it('stops at a failed hook, deleting it when it asked for hook-failed, and records the release failed', async () => {
        const render = chartRender();
        render.hooks = [hook('migrate', ['pre-install'], 0, ['hook-failed'])];
        renderMod.renderChart.mockResolvedValue({ ok: true, render });
        const reviewId = await reviewed();
        objects.read.mockImplementation((object: Named) => {
            if (!cluster.has(object.metadata.name)) return Promise.reject(apiError(404));
            return Promise.resolve(
                object.kind === 'CustomResourceDefinition'
                    ? { status: { conditions: [{ type: 'Established', status: 'True' }] } }
                    : {
                          kind: 'Job',
                          status: { conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] },
                      },
            );
        });
        const result = await install.installRelease({ context: 'alpha', reviewId });
        expect(result.status).toBe('failed');
        expect(result.message).toMatch(/Job "migrate" in team-a failed: job failed: BackoffLimitExceeded/);
        expect(createdKinds()).not.toContain('ConfigMap/web');
        expect(objects.delete).toHaveBeenCalledWith(
            expect.objectContaining({ metadata: expect.objectContaining({ name: 'migrate' }) }),
            undefined,
            undefined,
            undefined,
            undefined,
            'Background',
        );
        const hooks = helmReads(secret!).hooks as { last_run?: { phase: string } }[];
        expect(hooks[0]!.last_run!.phase).toBe('Failed');
    });

    it('records a hook whose create was refused as finished and failed, which the Helm CLI can read', async () => {
        const render = chartRender();
        render.hooks = [hook('migrate', ['pre-install'], 0, ['hook-failed'])];
        renderMod.renderChart.mockResolvedValue({ ok: true, render });
        const reviewId = await reviewed();
        objects.create.mockImplementation((object: Named) => {
            if (object.metadata.name === 'migrate') return Promise.reject(apiError(403, 'denied by a webhook'));
            cluster.add(object.metadata.name);
            return Promise.resolve({});
        });
        const result = await install.installRelease({ context: 'alpha', reviewId });
        expect(result.status).toBe('failed');
        expect(createdKinds()).not.toContain('ConfigMap/web');
        // Nothing was created, so the hook-failed policy has nothing to delete.
        expect(objects.delete).not.toHaveBeenCalledWith(
            expect.objectContaining({ metadata: expect.objectContaining({ name: 'migrate' }) }),
            undefined,
            undefined,
            undefined,
            undefined,
            'Background',
        );
        const hooks = helmReads(secret!).hooks as { last_run?: { completed_at: string; phase: string } }[];
        // Go cannot parse an empty time, and a release recorded with one is skipped by `helm list`.
        expect(hooks[0]!.last_run!.phase).toBe('Failed');
        expect(Number.isNaN(Date.parse(hooks[0]!.last_run!.completed_at))).toBe(false);
    });

    it('says where a release was left when the context changed mid-install, writing nothing more', async () => {
        const reviewId = await reviewed();
        objects.create.mockImplementation((object: Named) => {
            if (object.kind === 'ConfigMap') client.activeContextName.mockReturnValue('beta');
            cluster.add(object.metadata.name);
            return Promise.resolve({});
        });
        await expect(install.installRelease({ context: 'alpha', reviewId })).rejects.toThrow(/left pending on alpha/);
        expect(core.replaceNamespacedSecret).not.toHaveBeenCalled();
        expect(createdKinds()).not.toContain('ClusterRole/web-reader');
    });
});
