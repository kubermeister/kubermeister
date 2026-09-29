import { z } from 'zod';
import { chartVersionInputSchema } from './chart-values.js';
import { chartRepositoryNameSchema } from './charts.js';
import { DNS_LABEL, namespaceNameSchema } from './k8s/names.js';

/**
 * Installing a chart is two calls. `charts.render` renders it with the values the editor holds,
 * puts every object through a server-side dry run and keeps the result in main as a review;
 * `releases.install` writes exactly that review, so what was read on screen is what reaches the
 * cluster and nothing is rendered a second time. A review names the context and namespace it was
 * rendered for, and both calls carry the context stamp every write does.
 */

/** Helm's own limit on a release name, which also names its Secrets and labels. */
export const MAX_RELEASE_NAME = 53;

/** Why a release name would be refused, in a sentence; null when it is a name Helm takes. */
export function releaseNameProblem(name: string): string | null {
    if (name === '') return 'Name the release.';
    if (name.length > MAX_RELEASE_NAME) return `A release name is at most ${MAX_RELEASE_NAME} characters.`;
    if (!DNS_LABEL.test(name))
        return 'Lowercase letters, digits and dashes, starting and ending with a letter or digit.';
    return null;
}

export const releaseNameSchema = z.string().superRefine((name, ctx) => {
    const problem = releaseNameProblem(name);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Values as JSON, which is how they reach Helm: the renderer parses the editor's text the way the
 * editor checks it (YAML 1.2, so `yes` is a string) and Helm reads the JSON with no second opinion.
 * A number JSON cannot carry (`.inf`, `.nan`) is refused rather than turned into null on the way.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
    z.union([
        z.string(),
        z.number().refine(Number.isFinite, 'JSON carries no infinite or NaN number'),
        z.boolean(),
        z.null(),
        z.array(jsonValueSchema),
        z.record(z.string(), jsonValueSchema),
    ]),
);

export const chartValuesObjectSchema = z.record(z.string(), jsonValueSchema);

export const chartRenderInputSchema = chartVersionInputSchema.extend({
    context: z.string().min(1),
    name: releaseNameSchema,
    namespace: namespaceNameSchema,
    values: chartValuesObjectSchema,
});

/**
 * What the dry run said about one object. `deferred` is an object whose kind a CRD of the same chart
 * defines, which the API server cannot check before that CRD exists; `exists` is a CRD already in
 * the cluster, which Helm leaves as it is rather than updating; `failed` refuses the install.
 */
export const dryRunCheckSchema = z.discriminatedUnion('state', [
    z.object({ state: z.literal('passed') }),
    z.object({ state: z.literal('deferred'), message: z.string() }),
    z.object({ state: z.literal('exists'), message: z.string() }),
    z.object({ state: z.literal('failed'), message: z.string() }),
]);

export const reviewedObjectSchema = z.object({
    apiVersion: z.string(),
    kind: z.string(),
    name: z.string(),
    /** Null for a cluster-scoped kind. */
    namespace: z.string().nullable(),
    /** The template it came from, as Helm names it. */
    source: z.string(),
    manifest: z.string(),
    check: dryRunCheckSchema,
});

export const reviewedHookSchema = reviewedObjectSchema.extend({
    events: z.array(z.string()),
    weight: z.number().int(),
    deletePolicies: z.array(z.string()),
});

export const chartReviewSchema = z.object({
    /** What `releases.install` names to write this review; it expires, and is spent by one install. */
    reviewId: z.string(),
    name: z.string(),
    namespace: z.string(),
    source: chartRepositoryNameSchema,
    chart: z.string(),
    version: z.string(),
    /** In the order they are written: CRDs, then pre-install hooks, objects and post-install hooks. */
    crds: z.array(reviewedObjectSchema),
    objects: z.array(reviewedObjectSchema),
    hooks: z.array(reviewedHookSchema),
    /** Whether a template calls `lookup`, which found nothing while rendering. */
    usesLookup: z.boolean(),
});

/** A render Helm refused is an answer the values editor lays over the values, not a failure. */
export const chartRenderOutcomeSchema = z.discriminatedUnion('rendered', [
    z.object({ rendered: z.literal(true), review: chartReviewSchema }),
    z.object({ rendered: z.literal(false), reason: z.string(), message: z.string() }),
]);

export const releaseInstallInputSchema = z.object({
    context: z.string().min(1),
    reviewId: z.string().min(1).max(64),
});

/**
 * How an install ended once its release was recorded. A failure part-way is recorded as `failed`, as
 * Helm records it, so the objects already written belong to a release that can be uninstalled.
 */
export const releaseInstallResultSchema = z.object({
    name: z.string(),
    namespace: z.string(),
    revision: z.number().int().positive(),
    status: z.enum(['deployed', 'failed']),
    /** Why a failed install stopped, in a sentence; null once deployed. */
    message: z.string().nullable(),
});

/** The versions a source lists for one chart, newest first; null for an OCI registry, which lists none. */
export const chartVersionsSchema = z.array(z.string()).nullable();

export const chartVersionsInputSchema = z.object({
    source: chartRepositoryNameSchema,
    chart: z.string().min(1).max(253),
});

/**
 * Why a review cannot be installed, in a sentence, or null when it can: an object its dry run
 * refused would stop the install part-way, so the install is refused before it starts.
 */
export function reviewProblem(review: Pick<ChartReview, 'crds' | 'objects' | 'hooks'>): string | null {
    for (const one of [...review.crds, ...review.objects, ...review.hooks]) {
        if (one.check.state === 'failed') return `The dry run refused ${one.kind} "${one.name}": ${one.check.message}`;
    }
    return null;
}

export type ChartRenderInput = z.infer<typeof chartRenderInputSchema>;
export type DryRunCheck = z.infer<typeof dryRunCheckSchema>;
export type ReviewedObject = z.infer<typeof reviewedObjectSchema>;
export type ReviewedHook = z.infer<typeof reviewedHookSchema>;
export type ChartReview = z.infer<typeof chartReviewSchema>;
export type ChartRenderOutcome = z.infer<typeof chartRenderOutcomeSchema>;
export type ReleaseInstallInput = z.infer<typeof releaseInstallInputSchema>;
export type ReleaseInstallResult = z.infer<typeof releaseInstallResultSchema>;
export type ChartVersionsInput = z.infer<typeof chartVersionsInputSchema>;
