import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { KubernetesObject, V1Secret } from '@kubernetes/client-node';
import type {
    JsonValue,
    ReleaseInstallInput,
    ReleaseInstallResult,
    ReviewedHook,
} from '../../../shared/chart-install.js';
import {
    upgradeProblem,
    type ChartUpgradeInput,
    type ChartUpgradeOutcome,
    type ChartUpgradeReview,
    type RemovedObject,
    type UpgradedObject,
} from '../../../shared/chart-upgrade.js';
import { isClusterScopedKindName } from '../../../shared/k8s/registry.js';
import { fetchChart } from '../../charts/fetch.js';
import { helmChartRecord, type HelmChartRecord } from '../../charts/release-chart.js';
import { renderChart, type ChartRender, type RenderedHook, type RenderedManifest } from '../../charts/render.js';
import { clusterCapabilities } from '../capabilities.js';
import { activeContextName, apis } from '../client.js';
import { K8sError, toK8sError, withK8s } from '../errors.js';
import { yamlToText } from '../yaml.js';
import { cleanForExport } from './export.js';
import {
    applyObject,
    chartLabel,
    manifestObjects,
    objectKey,
    ownedByRelease,
    releaseSecretBody,
    releaseSecretName,
    releaseSecrets,
    releaseValues,
    removeObject,
    restatusRevision,
    goneBetween,
    isKept,
    withHelmOwnership,
    type HelmReleaseData,
    type RenderedObject,
} from './helm.js';
import {
    DRY_RUN_CONCURRENCY,
    BEFORE_HOOK_CREATION,
    REVIEW_TTL_MS,
    describeObject,
    dryRun,
    effectiveDeletePolicies,
    failureMessage,
    hookRecord,
    hooksFor,
    mapLimited,
    placed,
    reviewStore,
    runHooks,
    statusCode,
    step,
    type HookRun,
} from './helm-install.js';
import { assertContext } from './write.js';

/*
 * Upgrading a release the way `helm upgrade` does, through the same parts an install uses. The new
 * chart version is rendered once for a review, which diffs each object against the one the cluster
 * holds through a server-side dry run of the very write the upgrade sends, and lists what the new
 * revision drops. The upgrade then writes that render in Helm's order: the new revision recorded as
 * `pending-upgrade`, the `pre-upgrade` hooks, the objects, the deletions, the `post-upgrade` hooks,
 * the previous revision marked `superseded` and the new one `deployed`. A failure part-way marks the
 * new revision `failed` and leaves the previous one deployed, as Helm does.
 */

const REVIEW_OP = 'charts.renderUpgrade';
const UPGRADE_OP = 'releases.upgrade';

type Revision = { secret: V1Secret; data: HelmReleaseData };

interface PendingUpgrade {
    review: ChartUpgradeReview;
    context: string;
    render: ChartRender;
    chart: HelmChartRecord;
    values: Record<string, JsonValue>;
    /** The revision the review started from, and the newest one then, which must still be newest. */
    current: Revision;
    last: number;
    /** What the new revision drops, as the current one rendered it. */
    removed: RenderedObject[];
    /** The objects the dry run found already as the render has them. */
    unchanged: Set<string>;
    expires: number;
}

const pending = reviewStore<PendingUpgrade>();

/** Forget every review, which a test and nothing else needs. */
export function clearUpgradeReviews(): void {
    pending.clear();
}

/**
 * The revision an upgrade starts from and the number it records, as Helm's `prepareUpgrade` chooses
 * them: the newest revision when it is deployed, else the deployed one under it, else a newest that
 * failed or was superseded. The number always follows the newest. A revision another operation holds
 * pending is refused, as Helm refuses it, and an uninstalled release is installed again, not upgraded.
 */
export function upgradeBase(
    revisions: Revision[],
    name: string,
    namespace: string,
    op = REVIEW_OP,
): { current: Revision; last: number; next: number } {
    const newest = revisions[0];
    if (!newest) throw new K8sError('notFound', `No Helm release "${name}" in namespace ${namespace}.`, op);
    const status = newest.data.info?.status ?? '';
    if (status.startsWith('pending-')) {
        throw new K8sError(
            'conflict',
            `Release "${name}" is ${status}: another operation on it is in progress. Wait for it to finish, or roll it back.`,
            op,
        );
    }
    const last = newest.data.version ?? 0;
    const deployed = revisions.find((one) => one.data.info?.status === 'deployed');
    const current =
        status === 'deployed' ? newest : (deployed ?? (['failed', 'superseded'].includes(status) ? newest : null));
    if (!current) {
        throw new K8sError(
            'invalid',
            `Release "${name}" is ${status || 'not deployed'} and has no deployed revision to upgrade; install it again instead.`,
            op,
        );
    }
    return { current, last, next: last + 1 };
}

/** An object in the form both sides of a diff take: what the server owns dropped, keys in its order. */
const diffText = (object: object): string => yamlToText(cleanForExport(object));

/** Values in the form both sides of the values diff take; empty when there are none. */
const valuesText = (config: Record<string, unknown> | undefined): string => releaseValues({ config }) ?? '';

async function readLive(object: RenderedObject): Promise<KubernetesObject | null> {
    try {
        return await apis().objects.read(object);
    } catch (error) {
        if (statusCode(error) === 404) return null;
        throw error;
    }
}

/** The hooks an upgrade runs, in the order it runs them, followed by those it only records. */
function upgradeHooks(hooks: RenderedHook[]): RenderedHook[] {
    const pre = hooksFor(hooks, 'pre-upgrade');
    const post = hooksFor(hooks, 'post-upgrade').filter((hook) => !pre.includes(hook));
    return [...pre, ...post, ...hooks.filter((hook) => !pre.includes(hook) && !post.includes(hook))];
}

const namespaceOf = (object: RenderedObject): string | null =>
    isClusterScopedKindName(object.kind) ? null : (object.metadata.namespace ?? null);

/**
 * What the upgrade will do to one rendered object, checked by a dry run of the very write it sends:
 * a create for one the cluster lacks, a replace carrying the version it read for one it holds. The
 * two diff sides are the live object and the dry run's answer, both as the server stores them, so a
 * field the server fills in is not a change and one the render drops is. An object the current
 * revision did not render is adopted only when it already carries this release's ownership.
 */
async function checkObject(
    rendered: RenderedManifest,
    release: string,
    namespace: string,
    previous: Set<string>,
): Promise<UpgradedObject> {
    const object = withHelmOwnership(structuredClone(rendered.object), release, namespace);
    const base = {
        apiVersion: object.apiVersion,
        kind: object.kind,
        name: object.metadata.name,
        namespace: namespaceOf(object),
        source: rendered.source,
        manifest: rendered.manifest,
    };
    const current = await readLive(object);
    if (!current) {
        try {
            const answer = await apis().objects.create(structuredClone(object), undefined, 'All');
            return { ...base, change: 'create', check: { state: 'passed' }, live: '', next: diffText(answer) };
        } catch (error) {
            const check = { state: 'failed' as const, message: failureMessage(error, object, REVIEW_OP) };
            return { ...base, change: 'create', check, live: '', next: diffText(object) };
        }
    }
    const live = diffText(current);
    if (!previous.has(objectKey(rendered.object)) && !ownedByRelease(current, release, namespace)) {
        return {
            ...base,
            change: 'update',
            check: {
                state: 'failed',
                message: `${describeObject(object)} exists and is not owned by release "${release}", and Helm takes over nothing another release or tool put there.`,
            },
            live,
            next: diffText(object),
        };
    }
    try {
        const answer = await apis().objects.replace(
            { ...object, metadata: { ...object.metadata, resourceVersion: current.metadata?.resourceVersion } },
            undefined,
            'All',
        );
        const next = diffText(answer);
        return { ...base, change: next === live ? 'unchanged' : 'update', check: { state: 'passed' }, live, next };
    } catch (error) {
        return {
            ...base,
            change: 'update',
            check: { state: 'failed', message: failureMessage(error, object, REVIEW_OP) },
            live,
            next: diffText(object),
        };
    }
}

async function checkRemoved(object: RenderedObject): Promise<RemovedObject> {
    const current = await readLive(object);
    return {
        apiVersion: object.apiVersion,
        kind: object.kind,
        name: object.metadata.name,
        namespace: namespaceOf(object),
        kept: isKept(object),
        live: current ? diffText(current) : null,
    };
}

/**
 * Render a chart version as an upgrade of a release and check what it would change. Answers the
 * review, which `upgradeRelease` then writes, or Helm's refusal, which the values editor lays over
 * the values. The values are the whole of what the release is given, as `helm upgrade --values`
 * takes them: the editor starts from the current revision's own, so nothing is reused silently.
 */
export async function reviewUpgrade(input: ChartUpgradeInput): Promise<ChartUpgradeOutcome> {
    assertContext(input.context, REVIEW_OP);
    const { current, last, next } = await withK8s(REVIEW_OP, async () =>
        upgradeBase(await releaseSecrets(input.name, input.namespace), input.name, input.namespace),
    );
    const fetched = await fetchChart(input.source, input.chart, input.version);
    const capabilities = await clusterCapabilities();
    const outcome = await renderChart(fetched.path, input.values, capabilities, {
        name: input.name,
        namespace: input.namespace,
        upgrade: true,
    });
    if (!outcome.ok) return { rendered: false, reason: outcome.error.reason, message: outcome.error.message };

    const render = placed(outcome.render, input.namespace);
    const hooks = upgradeHooks(render.hooks);
    const previousObjects = manifestObjects(current.data.manifest, input.namespace);
    const previous = new Set(previousObjects.map(objectKey));
    const removed = goneBetween(
        previousObjects,
        render.objects.map((one) => one.object),
    );
    const checks = await withK8s(REVIEW_OP, async () => ({
        objects: await mapLimited(render.objects, DRY_RUN_CONCURRENCY, (one) =>
            checkObject(one, input.name, input.namespace, previous),
        ),
        removed: await mapLimited(removed, DRY_RUN_CONCURRENCY, checkRemoved),
        hooks: await mapLimited(hooks, DRY_RUN_CONCURRENCY, (one) =>
            dryRun(one.object, 'hook', new Set(), effectiveDeletePolicies(one).includes(BEFORE_HOOK_CREATION)),
        ),
    }));
    // The render took as long as Helm did; a context switch meanwhile makes it a review of the wrong cluster.
    assertContext(input.context, REVIEW_OP);

    const review: ChartUpgradeReview = {
        reviewId: randomUUID(),
        name: input.name,
        namespace: input.namespace,
        source: input.source,
        chart: input.chart,
        version: input.version,
        revision: next,
        from: { revision: current.data.version ?? 0, chart: chartLabel(current.data) },
        previousValues: valuesText(current.data.config),
        values: valuesText(input.values),
        objects: checks.objects,
        removed: checks.removed,
        hooks: hooks.map((one, i): ReviewedHook => ({
            apiVersion: one.object.apiVersion,
            kind: one.object.kind,
            name: one.object.metadata.name,
            namespace: namespaceOf(one.object),
            source: one.source,
            manifest: one.manifest,
            check: checks.hooks[i]!,
            events: one.events,
            weight: one.weight,
            deletePolicies: one.deletePolicies,
        })),
        skippedCrds: render.crds.length,
        usesLookup: render.usesLookup,
    };
    pending.remember({
        review,
        context: input.context,
        render: { ...render, hooks },
        chart: await helmChartRecord(await readFile(fetched.path)),
        values: input.values,
        current,
        last,
        removed,
        unchanged: new Set(
            render.objects
                .filter((_, i) => checks.objects[i]!.change === 'unchanged')
                .map((one) => objectKey(one.object)),
        ),
        expires: Date.now() + REVIEW_TTL_MS,
    });
    return { rendered: true, review };
}

/** The revision an upgrade records, before any status beyond `pending-upgrade`. */
export function upgradedRevision(
    entry: Pick<PendingUpgrade, 'review' | 'render' | 'chart' | 'values' | 'current'>,
    now: string,
    hooks: HelmReleaseData['hooks'],
): HelmReleaseData {
    return {
        name: entry.review.name,
        namespace: entry.review.namespace,
        version: entry.review.revision,
        info: {
            first_deployed: entry.current.data.info?.first_deployed ?? now,
            last_deployed: now,
            description: 'Preparing upgrade',
            status: 'pending-upgrade',
            notes: '',
        },
        chart: { ...entry.chart },
        config: entry.values,
        manifest: entry.render.manifest,
        hooks,
    };
}

/**
 * Create an object the dry run found unchanged only if it has gone since, and otherwise leave it:
 * Helm patches nothing where the render did not change, so a field somebody set since stays.
 */
async function ensurePresent(object: RenderedObject, release: string, namespace: string): Promise<void> {
    try {
        await apis().objects.create(withHelmOwnership(structuredClone(object), release, namespace));
    } catch (error) {
        if (statusCode(error) !== 409) throw error;
    }
}

/**
 * Upgrade the release a review rendered. A review is spent by its upgrade, whatever the outcome, and
 * one that has expired, belongs to another context, was refused by its dry run, or was made before
 * another revision was recorded is refused before anything is written. Once the new revision is
 * recorded, a failure is an answer rather than an error: it is marked `failed`, as Helm marks it.
 */
export async function upgradeRelease(input: ReleaseInstallInput): Promise<ReleaseInstallResult> {
    const entry = pending.take(input.reviewId);
    if (!entry) {
        throw new K8sError(
            'invalid',
            'This review has expired. Review the upgrade again before applying it.',
            UPGRADE_OP,
        );
    }
    assertContext(input.context, UPGRADE_OP);
    if (entry.context !== input.context || activeContextName() !== entry.context) {
        throw new K8sError(
            'conflict',
            'This review was rendered for another context. Review the upgrade again.',
            UPGRADE_OP,
        );
    }
    const problem = upgradeProblem(entry.review);
    if (problem) throw new K8sError('invalid', problem, UPGRADE_OP);

    const { name, namespace, revision } = entry.review;
    const context = entry.context;
    const base = await step(UPGRADE_OP, context, async () => {
        const now = upgradeBase(await releaseSecrets(name, namespace), name, namespace, UPGRADE_OP);
        if (now.last !== entry.last || now.current.data.version !== entry.current.data.version) {
            throw new K8sError(
                'conflict',
                `Release "${name}" has changed since it was reviewed: it is at revision ${now.last} now. Review the upgrade again.`,
                UPGRADE_OP,
            );
        }
        return now.current;
    });

    const runs = new Map<RenderedHook, HookRun>();
    const hooksNow = () => entry.render.hooks.map((hook) => hookRecord(hook, runs.get(hook)?.lastRun));
    let record = upgradedRevision(entry, new Date().toISOString(), hooksNow());
    const secretName = releaseSecretName(name, revision);
    const write = async (next: HelmReleaseData) => {
        const body = releaseSecretBody(next);
        await step(UPGRADE_OP, context, async () => {
            const live = await apis().core.readNamespacedSecret({ name: secretName, namespace });
            await apis().core.replaceNamespacedSecret({
                name: secretName,
                namespace,
                body: { ...body, metadata: { ...body.metadata, resourceVersion: live.metadata?.resourceVersion } },
            });
        });
        record = next;
    };
    await step(UPGRADE_OP, context, () =>
        apis().core.createNamespacedSecret({ namespace, body: releaseSecretBody(record) }),
    );

    try {
        await runHooks(UPGRADE_OP, context, hooksFor(entry.render.hooks, 'pre-upgrade'), runs);
        for (const { object } of entry.render.objects) {
            await step(UPGRADE_OP, context, () =>
                entry.unchanged.has(objectKey(object))
                    ? ensurePresent(object, name, namespace)
                    : applyObject(structuredClone(object), name, namespace),
            );
        }
        for (const object of entry.removed.filter((one) => !isKept(one))) {
            await step(UPGRADE_OP, context, () => removeObject(object));
        }
        await runHooks(UPGRADE_OP, context, hooksFor(entry.render.hooks, 'post-upgrade'), runs);
        await step(UPGRADE_OP, context, () => restatusRevision(base.secret, base.data, 'superseded'));
        await write({
            ...record,
            info: {
                ...record.info,
                status: 'deployed',
                description: 'Upgrade complete',
                last_deployed: new Date().toISOString(),
            },
            hooks: hooksNow(),
        });
        return { name, namespace, revision, status: 'deployed', message: null };
    } catch (error) {
        const message = toK8sError(UPGRADE_OP, error).detail;
        // On another context now, the release cannot be marked from here; say where it was left.
        if (activeContextName() !== context) {
            throw new K8sError(
                'conflict',
                `The context changed while upgrading: release "${name}" is left pending-upgrade on ${context}. ${message}`,
                UPGRADE_OP,
            );
        }
        await write({
            ...record,
            info: {
                ...record.info,
                status: 'failed',
                description: `Upgrade "${name}" failed: ${message}`,
                last_deployed: new Date().toISOString(),
            },
            hooks: hooksNow(),
        });
        return { name, namespace, revision, status: 'failed', message };
    }
}
