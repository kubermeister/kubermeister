import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ApiException, type KubernetesObject } from '@kubernetes/client-node';
import {
    reviewProblem,
    type ChartRenderInput,
    type ChartRenderOutcome,
    type ChartReview,
    type DryRunCheck,
    type JsonValue,
    type ReleaseInstallInput,
    type ReleaseInstallResult,
    type ReviewedHook,
    type ReviewedObject,
} from '../../../shared/chart-install.js';
import { isClusterScopedKindName } from '../../../shared/k8s/registry.js';
import { fetchChart } from '../../charts/fetch.js';
import { helmChartRecord, type HelmChartRecord } from '../../charts/release-chart.js';
import { renderChart, type ChartRender, type RenderedHook, type RenderedManifest } from '../../charts/render.js';
import { clusterCapabilities } from '../capabilities.js';
import { activeContextName, apis } from '../client.js';
import { K8sError, toK8sError, withK8s } from '../errors.js';
import {
    describeObject,
    hasRelease,
    inReleaseNamespace,
    releaseSecretBody,
    releaseSecretName,
    type HelmHookRecord,
    type HelmReleaseData,
    type RenderedObject,
} from './helm.js';
import { applyForRelease } from './helm-apply.js';
import { assertContext } from './write.js';

/*
 * Installing a chart the way `helm install` does, through the app's own write path. The chart is
 * rendered once, by `helm template`, for a review: every object is put through a server-side dry
 * run and the whole render is kept here, so the install writes exactly what was read on screen.
 * The install then follows Helm's order — the CRDs from `crds/`, the release recorded as
 * `pending-install`, the `pre-install` hooks by weight and waited on, the objects in the order Helm
 * rendered them (its install order), the `post-install` hooks, and the release marked `deployed` —
 * and a failure part-way marks the release `failed`, as Helm does, so the objects already written
 * belong to a release that can be uninstalled rather than to nobody.
 *
 * Each step is a cluster call under its own read ceiling rather than the whole install under one:
 * a hook may run for minutes, and a ceiling that fired mid-install would also cancel the write that
 * records the failure.
 */

const REVIEW_OP = 'charts.render';
const INSTALL_OP = 'releases.install';

/** How long a review may wait for its Install; past this the cluster may have moved on under it. */
export const REVIEW_TTL_MS = 30 * 60 * 1000;
/** Reviews kept at once. Each holds a rendered chart, and only the newest is ever installed. */
const MAX_REVIEWS = 8;

/** Helm's default `--timeout`: how long one hook may take to finish. */
export const HOOK_TIMEOUT_MS = 5 * 60 * 1000;
/** How long a CRD may take to be served, and an object deleted before its hook is recreated. */
const SETTLE_TIMEOUT_MS = 60 * 1000;
const POLL_MS = 1000;
/** Dry runs in flight at once, so a chart of a hundred objects does not open a hundred requests. */
export const DRY_RUN_CONCURRENCY = 6;

export const BEFORE_HOOK_CREATION = 'before-hook-creation';
const HOOK_SUCCEEDED = 'hook-succeeded';
const HOOK_FAILED = 'hook-failed';

interface Pending {
    review: ChartReview;
    context: string;
    render: ChartRender;
    chart: HelmChartRecord;
    values: Record<string, JsonValue>;
    expires: number;
}

/**
 * Reviews waiting for the write they were rendered for, each kept until it expires, is displaced by
 * newer ones or is spent. An upgrade keeps its own, since its review carries different things.
 */
export function reviewStore<T extends { review: { reviewId: string }; expires: number }>() {
    const entries = new Map<string, T>();
    return {
        remember(entry: T): void {
            const now = Date.now();
            for (const [id, one] of entries) if (one.expires <= now) entries.delete(id);
            while (entries.size >= MAX_REVIEWS) entries.delete(entries.keys().next().value!);
            entries.set(entry.review.reviewId, entry);
        },
        /** The review under this id, which taking it spends, or null for one expired or never made. */
        take(id: string): T | null {
            const entry = entries.get(id);
            entries.delete(id);
            return entry && entry.expires > Date.now() ? entry : null;
        },
        clear(): void {
            entries.clear();
        },
    };
}

const pending = reviewStore<Pending>();

/** Forget every review, which a test and nothing else needs. */
export function clearReviews(): void {
    pending.clear();
}

/** A hook's delete policies as Helm applies them: none written means `before-hook-creation`. */
export function effectiveDeletePolicies(hook: Pick<RenderedHook, 'deletePolicies'>): string[] {
    return hook.deletePolicies.length > 0 ? hook.deletePolicies : [BEFORE_HOOK_CREATION];
}

/** The hooks one event runs, in Helm's order: by weight, then by name. */
export function hooksFor<T extends Pick<RenderedHook, 'events' | 'weight' | 'object'>>(hooks: T[], event: string): T[] {
    return hooks
        .filter((hook) => hook.events.includes(event))
        .sort((a, b) => a.weight - b.weight || a.object.metadata.name.localeCompare(b.object.metadata.name));
}

type HookProgress = { done: false } | { done: true; failed: string | null };

/**
 * Whether a hook has finished, read from the object as the cluster holds it. Helm waits on a Job
 * until it completes or fails and on a Pod until it succeeds or fails; every other kind is done the
 * moment it exists.
 */
export function hookProgress(object: KubernetesObject & { status?: unknown }): HookProgress {
    const status = (object.status ?? {}) as {
        conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
        phase?: string;
    };
    if (object.kind === 'Job') {
        const conditions = status.conditions ?? [];
        const failed = conditions.find((one) => one.type === 'Failed' && one.status === 'True');
        if (failed) return { done: true, failed: `job failed: ${failed.reason ?? failed.message ?? 'unknown reason'}` };
        const complete = conditions.find((one) => one.type === 'Complete' && one.status === 'True');
        return complete ? { done: true, failed: null } : { done: false };
    }
    if (object.kind === 'Pod') {
        if (status.phase === 'Succeeded') return { done: true, failed: null };
        if (status.phase === 'Failed') return { done: true, failed: 'pod failed' };
        return { done: false };
    }
    return { done: true, failed: null };
}

function crdKinds(crds: RenderedManifest[]): Set<string> {
    const kinds = new Set<string>();
    for (const { object } of crds) {
        const spec = (object as { spec?: { group?: unknown; names?: { kind?: unknown } } }).spec;
        if (typeof spec?.group === 'string' && typeof spec.names?.kind === 'string') {
            kinds.add(`${spec.group}/${spec.names.kind}`);
        }
    }
    return kinds;
}

export const groupOf = (apiVersion: string): string => (apiVersion.includes('/') ? apiVersion.split('/')[0]! : '');

export function statusCode(error: unknown): number | undefined {
    return error instanceof ApiException ? error.code : undefined;
}

export function failureMessage(error: unknown, object: RenderedObject, op = INSTALL_OP): string {
    if (statusCode(error) === 404) return `The cluster serves no ${object.apiVersion} ${object.kind}.`;
    if (error instanceof Error && error.message.startsWith('Unrecognized API version and kind')) {
        return `The cluster serves no ${object.apiVersion} ${object.kind}.`;
    }
    return toK8sError(op, error).detail;
}

type Checked = 'object' | 'hook' | 'crd';

/**
 * What a server-side dry run says about one object. An object that already exists is refused, as
 * Helm refuses to install over something it does not own, except a CRD, which Helm leaves as it is,
 * and a hook that is deleted before it is created again. A kind one of the chart's own CRDs defines
 * cannot be checked before that CRD is served, so it waits for the install.
 */
export async function dryRun(
    object: RenderedObject,
    role: Checked,
    chartKinds: Set<string>,
    replacedHook: boolean,
): Promise<DryRunCheck> {
    try {
        await apis().objects.create(structuredClone(object), undefined, 'All');
        return { state: 'passed' };
    } catch (error) {
        if (statusCode(error) === 409) {
            if (role === 'crd') return { state: 'exists', message: 'Already in the cluster; Helm leaves it as it is.' };
            if (replacedHook) return { state: 'passed' };
            return {
                state: 'failed',
                message: `${describeObject(object)} already exists, and Helm installs over nothing it does not own.`,
            };
        }
        if (chartKinds.has(`${groupOf(object.apiVersion)}/${object.kind}`)) {
            return {
                state: 'deferred',
                message: 'Its kind comes from a CRD in this chart, so it is checked once that is installed.',
            };
        }
        return { state: 'failed', message: failureMessage(error, object) };
    }
}

export async function mapLimited<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const at = next++;
            out[at] = await run(items[at]!);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

function reviewed(rendered: RenderedManifest, check: DryRunCheck): ReviewedObject {
    const { object } = rendered;
    return {
        apiVersion: object.apiVersion,
        kind: object.kind,
        name: object.metadata.name,
        namespace: isClusterScopedKindName(object.kind) ? null : (object.metadata.namespace ?? null),
        source: rendered.source,
        manifest: rendered.manifest,
        check,
    };
}

/** Every rendered object placed in the release's namespace, the way the install will write it. */
export function placed(render: ChartRender, namespace: string): ChartRender {
    const place = <T extends RenderedManifest>(one: T): T => ({
        ...one,
        object: inReleaseNamespace(one.object, namespace),
    });
    return {
        ...render,
        crds: render.crds.map((one) => ({ ...one })),
        objects: render.objects.map(place),
        hooks: render.hooks.map(place),
    };
}

/** The hooks an install runs, in the order it runs them, followed by those it only records. */
function installHooks(hooks: RenderedHook[]): RenderedHook[] {
    const pre = hooksFor(hooks, 'pre-install');
    const post = hooksFor(hooks, 'post-install').filter((hook) => !pre.includes(hook));
    return [...pre, ...post, ...hooks.filter((hook) => !pre.includes(hook) && !post.includes(hook))];
}

/**
 * Render a chart for an install and check what it rendered. Answers the review, which `install`
 * then writes, or Helm's refusal, which the values editor lays over the values. The release name
 * must be free in the namespace, as `helm install` requires. The values are the user's overrides
 * alone, as `helm install -f` takes them, reaching Helm as JSON over the chart's own `values.yaml`,
 * which Helm reads itself; they are also the release's `config`, as `helm get values` shows it.
 */
export async function reviewChart(input: ChartRenderInput): Promise<ChartRenderOutcome> {
    assertContext(input.context, REVIEW_OP);
    const fetched = await fetchChart(input.source, input.chart, input.version);
    await withK8s(REVIEW_OP, async () => {
        if (await hasRelease(input.name, input.namespace)) {
            throw new K8sError(
                'conflict',
                `A release named "${input.name}" already exists in namespace ${input.namespace}.`,
                REVIEW_OP,
            );
        }
    });
    const capabilities = await clusterCapabilities();
    const outcome = await renderChart(fetched.path, input.values, capabilities, {
        name: input.name,
        namespace: input.namespace,
    });
    if (!outcome.ok) return { rendered: false, reason: outcome.error.reason, message: outcome.error.message };

    const render = placed(outcome.render, input.namespace);
    const chartKinds = crdKinds(render.crds);
    const hooks = installHooks(render.hooks);
    const checks = await withK8s(REVIEW_OP, async () => ({
        crds: await mapLimited(render.crds, DRY_RUN_CONCURRENCY, (one) => dryRun(one.object, 'crd', chartKinds, false)),
        objects: await mapLimited(render.objects, DRY_RUN_CONCURRENCY, (one) =>
            dryRun(one.object, 'object', chartKinds, false),
        ),
        hooks: await mapLimited(hooks, DRY_RUN_CONCURRENCY, (one) =>
            dryRun(one.object, 'hook', chartKinds, effectiveDeletePolicies(one).includes(BEFORE_HOOK_CREATION)),
        ),
    }));
    // The render took as long as Helm did; a context switch meanwhile makes it a review of the wrong cluster.
    assertContext(input.context, REVIEW_OP);

    const review: ChartReview = {
        reviewId: randomUUID(),
        name: input.name,
        namespace: input.namespace,
        source: input.source,
        chart: input.chart,
        version: input.version,
        crds: render.crds.map((one, i) => reviewed(one, checks.crds[i]!)),
        objects: render.objects.map((one, i) => reviewed(one, checks.objects[i]!)),
        hooks: hooks.map((one, i): ReviewedHook => ({
            ...reviewed(one, checks.hooks[i]!),
            events: one.events,
            weight: one.weight,
            deletePolicies: one.deletePolicies,
        })),
        usesLookup: render.usesLookup,
    };
    pending.remember({
        review,
        context: input.context,
        render: { ...render, hooks },
        chart: await helmChartRecord(await readFile(fetched.path)),
        values: input.values,
        expires: Date.now() + REVIEW_TTL_MS,
    });
    return { rendered: true, review };
}

/** A hook as the release records it. */
export function hookRecord(hook: RenderedHook, lastRun?: HelmHookRecord['last_run']): HelmHookRecord {
    return {
        name: hook.object.metadata.name,
        kind: hook.object.kind,
        path: hook.source,
        manifest: hook.manifest,
        events: hook.events,
        ...(lastRun ? { last_run: lastRun } : {}),
        weight: hook.weight,
        delete_policies: effectiveDeletePolicies(hook),
    };
}

/** The first revision of a release as Helm writes it, before any status beyond `pending-install`. */
export function firstRevision(
    entry: Pick<Pending, 'review' | 'render' | 'chart' | 'values'>,
    now: string,
    hooks: HelmHookRecord[],
): HelmReleaseData {
    return {
        name: entry.review.name,
        namespace: entry.review.namespace,
        version: 1,
        info: {
            first_deployed: now,
            last_deployed: now,
            description: 'Initial install underway',
            status: 'pending-install',
            notes: '',
        },
        chart: { ...entry.chart },
        config: entry.values,
        manifest: entry.render.manifest,
        hooks,
        apply_method: 'ssa',
    };
}

/** One cluster call under its own read ceiling, refused if the app has moved to another context. */
export function step<T>(op: string, context: string, run: () => Promise<T>): Promise<T> {
    return withK8s(op, async () => {
        assertContext(context, op);
        return run();
    });
}

async function until<T>(
    op: string,
    deadline: number,
    poll: () => Promise<T | undefined>,
    onTimeout: () => string,
): Promise<T> {
    for (;;) {
        const answer = await poll();
        if (answer !== undefined) return answer;
        if (Date.now() >= deadline) throw new K8sError('timeout', onTimeout(), op);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

async function exists(op: string, context: string, object: RenderedObject): Promise<boolean> {
    return step(op, context, () =>
        apis()
            .objects.read(object)
            .then(
                () => true,
                (error: unknown) => {
                    if (statusCode(error) === 404) return false;
                    throw error;
                },
            ),
    );
}

/** Delete an object and wait until the name is free, which a hook recreated under it needs. */
async function removeAndWait(op: string, context: string, object: RenderedObject): Promise<void> {
    await step(op, context, () =>
        apis()
            .objects.delete(object, undefined, undefined, undefined, undefined, 'Background')
            .catch((error: unknown) => {
                if (statusCode(error) !== 404) throw error;
            }),
    );
    await until(
        op,
        Date.now() + SETTLE_TIMEOUT_MS,
        async () => ((await exists(op, context, object)) ? undefined : true),
        () => `${describeObject(object)} is still being deleted.`,
    );
}

/** Create the chart's CRDs, leaving any already there alone, and wait until each is served. */
async function installCrds(context: string, crds: RenderedManifest[]): Promise<void> {
    for (const { object } of crds) {
        await step(INSTALL_OP, context, () =>
            apis()
                .objects.create(structuredClone(object))
                .catch((error: unknown) => {
                    if (statusCode(error) !== 409) throw error;
                }),
        );
    }
    for (const { object } of crds) {
        await until(
            INSTALL_OP,
            Date.now() + SETTLE_TIMEOUT_MS,
            async () => {
                const live = (await step(INSTALL_OP, context, () => apis().objects.read(object))) as {
                    status?: { conditions?: { type?: string; status?: string }[] };
                };
                const established = live.status?.conditions?.some(
                    (one) => one.type === 'Established' && one.status === 'True',
                );
                return established ? true : undefined;
            },
            () => `CustomResourceDefinition "${object.metadata.name}" was not established in time.`,
        );
    }
}

export interface HookRun {
    hook: RenderedHook;
    lastRun: NonNullable<HelmHookRecord['last_run']>;
}

/**
 * Run one event's hooks in order, waiting for each to finish, as Helm's `execHook` does. A hook
 * that fails or runs out of time is deleted when it asked for `hook-failed` and stops the install;
 * once every hook succeeded, those that asked for `hook-succeeded` are deleted.
 */
export async function runHooks(
    op: string,
    context: string,
    hooks: RenderedHook[],
    runs: Map<RenderedHook, HookRun>,
): Promise<void> {
    for (const hook of hooks) {
        const policies = effectiveDeletePolicies(hook);
        if (policies.includes(BEFORE_HOOK_CREATION)) await removeAndWait(op, context, hook.object);
        const run: HookRun = {
            hook,
            lastRun: { started_at: new Date().toISOString(), completed_at: '', phase: 'Running' },
        };
        runs.set(hook, run);
        await step(op, context, () => apis().objects.create(structuredClone(hook.object)));
        let failure: unknown = null;
        try {
            const failed = await until(
                op,
                Date.now() + HOOK_TIMEOUT_MS,
                async () => {
                    const progress = hookProgress(await step(op, context, () => apis().objects.read(hook.object)));
                    return progress.done ? progress.failed : undefined;
                },
                () =>
                    `The ${hook.events.join(', ')} hook ${describeObject(hook.object)} did not finish in ${HOOK_TIMEOUT_MS / 60_000} minutes.`,
            );
            if (failed)
                failure = new K8sError('invalid', `The hook ${describeObject(hook.object)} failed: ${failed}.`, op);
        } catch (error) {
            failure = error;
        }
        run.lastRun = {
            ...run.lastRun,
            completed_at: new Date().toISOString(),
            phase: failure ? 'Failed' : 'Succeeded',
        };
        if (failure) {
            if (policies.includes(HOOK_FAILED)) await removeAndWait(op, context, hook.object);
            throw failure;
        }
    }
    for (const hook of hooks) {
        if (effectiveDeletePolicies(hook).includes(HOOK_SUCCEEDED)) await removeAndWait(op, context, hook.object);
    }
}

/**
 * Install the chart a review rendered. A review is spent by its install, whatever the outcome, and
 * one that has expired, belongs to another context or was refused by its dry run is refused here
 * before anything is written. Once the release is recorded, a failure is an answer rather than an
 * error: the release is marked `failed` and the screen offers to uninstall it.
 */
export async function installRelease(input: ReleaseInstallInput): Promise<ReleaseInstallResult> {
    const entry = pending.take(input.reviewId);
    if (!entry) {
        throw new K8sError(
            'invalid',
            'This review has expired. Review the chart again before installing it.',
            INSTALL_OP,
        );
    }
    assertContext(input.context, INSTALL_OP);
    if (entry.context !== input.context || activeContextName() !== entry.context) {
        throw new K8sError(
            'conflict',
            'This review was rendered for another context. Review the chart again.',
            INSTALL_OP,
        );
    }
    const problem = reviewProblem(entry.review);
    if (problem) throw new K8sError('invalid', problem, INSTALL_OP);

    const { name, namespace } = entry.review;
    const context = entry.context;
    await step(INSTALL_OP, context, async () => {
        if (await hasRelease(name, namespace)) {
            throw new K8sError(
                'conflict',
                `A release named "${name}" already exists in namespace ${namespace}.`,
                INSTALL_OP,
            );
        }
    });

    // The CRDs come before the release exists, as in Helm: they belong to no release and outlive every one.
    await installCrds(context, entry.render.crds);

    const runs = new Map<RenderedHook, HookRun>();
    const now = new Date().toISOString();
    const hooksNow = () => entry.render.hooks.map((hook) => hookRecord(hook, runs.get(hook)?.lastRun));
    let record = firstRevision(entry, now, hooksNow());
    const secretName = releaseSecretName(name, 1);
    const write = async (next: HelmReleaseData) => {
        const body = releaseSecretBody(next);
        await step(INSTALL_OP, context, async () => {
            const live = await apis().core.readNamespacedSecret({ name: secretName, namespace });
            await apis().core.replaceNamespacedSecret({
                name: secretName,
                namespace,
                body: { ...body, metadata: { ...body.metadata, resourceVersion: live.metadata?.resourceVersion } },
            });
        });
        record = next;
    };
    await step(INSTALL_OP, context, () =>
        apis().core.createNamespacedSecret({ namespace, body: releaseSecretBody(record) }),
    );

    try {
        await runHooks(INSTALL_OP, context, hooksFor(entry.render.hooks, 'pre-install'), runs);
        for (const { object } of entry.render.objects) {
            // Applied server-side as Helm, as Helm 4 installs, so a later upgrade's apply owns what this wrote.
            await step(INSTALL_OP, context, () => applyForRelease(object, name, namespace));
        }
        await runHooks(INSTALL_OP, context, hooksFor(entry.render.hooks, 'post-install'), runs);
        await write({
            ...record,
            info: {
                ...record.info,
                status: 'deployed',
                description: 'Install complete',
                last_deployed: new Date().toISOString(),
            },
            hooks: hooksNow(),
        });
        return { name, namespace, revision: 1, status: 'deployed', message: null };
    } catch (error) {
        const message = toK8sError(INSTALL_OP, error).detail;
        // On another context now, the release cannot be marked from here; say where it was left.
        if (activeContextName() !== context) {
            throw new K8sError(
                'conflict',
                `The context changed while installing: release "${name}" is left pending on ${context}. ${message}`,
                INSTALL_OP,
            );
        }
        await write({
            ...record,
            info: {
                ...record.info,
                status: 'failed',
                description: `Release "${name}" failed: ${message}`,
                last_deployed: new Date().toISOString(),
            },
            hooks: hooksNow(),
        });
        return { name, namespace, revision: 1, status: 'failed', message };
    }
}
