import { z } from 'zod';
import { chartRenderInputSchema, reviewedHookSchema, reviewedObjectSchema, reviewProblem } from './chart-install.js';
import { chartRepositoryNameSchema } from './charts.js';

/**
 * Upgrading a release is the install's two calls over again. `charts.renderUpgrade` renders the
 * chart version for the release that exists, compares every object with the one the cluster holds
 * through a server-side dry run and keeps the result in main as a review; `releases.upgrade` writes
 * exactly that review, so the diff read on screen is the change that reaches the cluster.
 */

export const chartUpgradeInputSchema = chartRenderInputSchema;

/**
 * What an upgrade does to one object the new revision renders: `create` one the cluster lacks,
 * `update` one whose stored form would change, `unchanged` one the write leaves as it is.
 */
export const upgradeChangeSchema = z.enum(['create', 'update', 'unchanged']);

export const upgradedObjectSchema = reviewedObjectSchema.extend({
    change: upgradeChangeSchema,
    /** The object as the cluster holds it, without what the server owns; empty for a create. */
    live: z.string(),
    /** The object as the dry run says the cluster would hold it, in the same form, so the two diff. */
    next: z.string(),
});

/** An object the current revision rendered and the new one does not, which the upgrade deletes. */
export const removedObjectSchema = z.object({
    apiVersion: z.string(),
    kind: z.string(),
    name: z.string(),
    namespace: z.string().nullable(),
    /** Annotated `helm.sh/resource-policy: keep`, so it stays in the cluster and leaves the release. */
    kept: z.boolean(),
    /** The object as the cluster holds it, or null when it is already gone. */
    live: z.string().nullable(),
});

export const chartUpgradeReviewSchema = z.object({
    /** What `releases.upgrade` names to write this review; it expires, and is spent by one upgrade. */
    reviewId: z.string(),
    name: z.string(),
    namespace: z.string(),
    source: chartRepositoryNameSchema,
    chart: z.string(),
    version: z.string(),
    /** The revision the upgrade records. */
    revision: z.number().int().positive(),
    /** The revision it starts from, whose values and objects the diffs are against. */
    from: z.object({ revision: z.number().int().positive(), chart: z.string() }),
    /** The starting revision's user-supplied values and the new ones, both written the same way. */
    previousValues: z.string(),
    values: z.string(),
    objects: z.array(upgradedObjectSchema),
    removed: z.array(removedObjectSchema),
    /** Every hook the new revision renders; only pre-upgrade and post-upgrade ones run. */
    hooks: z.array(reviewedHookSchema),
    /** The chart's `crds/` definitions, which Helm installs only on install and an upgrade leaves alone. */
    skippedCrds: z.number().int().nonnegative(),
    usesLookup: z.boolean(),
});

export const chartUpgradeOutcomeSchema = z.discriminatedUnion('rendered', [
    z.object({ rendered: z.literal(true), review: chartUpgradeReviewSchema }),
    z.object({ rendered: z.literal(false), reason: z.string(), message: z.string() }),
]);

/** Why an upgrade review cannot be written, in a sentence, or null when it can. */
export function upgradeProblem(review: Pick<ChartUpgradeReview, 'objects' | 'hooks'>): string | null {
    return reviewProblem({ crds: [], objects: review.objects, hooks: review.hooks });
}

export type ChartUpgradeInput = z.infer<typeof chartUpgradeInputSchema>;
export type UpgradeChange = z.infer<typeof upgradeChangeSchema>;
export type UpgradedObject = z.infer<typeof upgradedObjectSchema>;
export type RemovedObject = z.infer<typeof removedObjectSchema>;
export type ChartUpgradeReview = z.infer<typeof chartUpgradeReviewSchema>;
export type ChartUpgradeOutcome = z.infer<typeof chartUpgradeOutcomeSchema>;
