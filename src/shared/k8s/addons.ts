import { z } from 'zod';
import { namespaceNameSchema } from './names.js';
import type { Kind } from './registry.js';

/** Helm's own release states, folded into the vocabulary the badges render. */
export const releaseStatusSchema = z.enum([
    'Deployed',
    'Superseded',
    'Failed',
    'Progressing',
    'Terminating',
    'Unknown',
]);

export const helmChartSchema = z.object({
    name: z.string(),
    repository: z.string(),
    latestVersion: z.string(),
    appVersion: z.string(),
    description: z.string(),
});

export const releaseSchema = z.object({
    name: z.string(),
    namespace: z.string(),
    chart: z.string(),
    revision: z.number(),
    status: releaseStatusSchema,
    updated: z.string(),
    /** User-supplied values as YAML, read only on a detail read and absent when all defaults. */
    values: z.string().optional(),
    /**
     * The objects this revision rendered, as one multi-document YAML string. Read only on a detail
     * read: a list carries one row per release, and a rendered manifest is the size of a chart.
     */
    manifest: z.string().optional(),
});

export const releaseRevisionSchema = z.object({
    rev: z.string(),
    status: releaseStatusSchema,
    chartVersion: z.string(),
    updated: z.string(),
    description: z.string(),
});

export const releaseTargetSchema = z.object({ name: z.string().min(1), namespace: namespaceNameSchema });

export const customResourceSchema = z.object({
    name: z.string(),
    group: z.string(),
    version: z.string(),
    scope: z.string(),
    kind: z.string(),
    age: z.string(),
});
export const customResourceDetailSchema = customResourceSchema.extend({
    labels: z.array(z.tuple([z.string(), z.string()])),
    annotations: z.array(z.tuple([z.string(), z.string()])),
});

/**
 * Rolling a release back re-applies the manifest one of its own revisions rendered, and records the
 * result as a new revision: Helm never rewinds the numbering, and neither does this.
 */
export const releaseRollbackInputSchema = z.object({
    context: z.string().min(1),
    name: z.string().min(1),
    namespace: namespaceNameSchema,
    revision: z.number().int().positive(),
});

export const releaseUninstallInputSchema = z.object({
    context: z.string().min(1),
    name: z.string().min(1),
    namespace: namespaceNameSchema,
    /** Keep the release's history, marked uninstalled, instead of deleting every revision's record. */
    keepHistory: z.boolean(),
});

/** What a release write did, in the terms the toast reports. */
export const releaseWriteResultSchema = z.object({
    name: z.string(),
    namespace: z.string(),
    /** The revision the release now runs, absent for an uninstall. */
    revision: z.number().int().nonnegative().optional(),
    /** Objects the write removed from the cluster. */
    removed: z.number().int().nonnegative(),
    /** Objects left in place because the chart asked for them to be kept. */
    kept: z.number().int().nonnegative(),
});

/**
 * The registered kinds whose list rows carry a status word of their own, which a release's
 * Resources tab shows beside each object it rendered. Every other kind, registered or not, reads as
 * present or missing and nothing more.
 */
export const RELEASE_STATUS_KINDS = [
    'Pod',
    'Deployment',
    'Job',
    'PodDisruptionBudget',
    'Service',
    'Ingress',
    'PersistentVolume',
    'PersistentVolumeClaim',
    'VolumeSnapshot',
    'MutatingWebhookConfiguration',
    'ValidatingWebhookConfiguration',
    'APIService',
] as const satisfies readonly Kind[];
export const releaseStatusKindSchema = z.enum(RELEASE_STATUS_KINDS);

/**
 * Whether an object the release rendered is in the cluster. `Unknown` is a kind the app was not
 * allowed to list, which says nothing either way, so it is never counted as missing.
 */
export const releaseObjectStateSchema = z.enum(['Present', 'Missing', 'Unknown']);

/** One object the current revision's stored manifest rendered, as the cluster holds it now. */
export const releaseObjectSchema = z.object({
    apiVersion: z.string(),
    kind: z.string(),
    name: z.string(),
    /** Absent for a cluster-scoped object. */
    namespace: z.string().optional(),
    state: releaseObjectStateSchema,
    /**
     * The status word the kind's own list shows, read through that kind's own transform, with the
     * registered kind whose tone map colours it. Null for a kind with no status of its own and for
     * an object that is not there to have one.
     */
    status: z.object({ kind: releaseStatusKindSchema, value: z.string() }).nullable(),
    /** The object's detail screen, or null when the registry has no screen for its kind. */
    path: z.string().nullable(),
    /** Why the state is `Unknown`, in a sentence. */
    note: z.string().optional(),
});

export type ReleaseStatus = z.infer<typeof releaseStatusSchema>;
export type HelmChart = z.infer<typeof helmChartSchema>;
export type Release = z.infer<typeof releaseSchema>;
export type ReleaseRevision = z.infer<typeof releaseRevisionSchema>;
export type ReleaseTarget = z.infer<typeof releaseTargetSchema>;
export type ReleaseRollbackInput = z.infer<typeof releaseRollbackInputSchema>;
export type ReleaseUninstallInput = z.infer<typeof releaseUninstallInputSchema>;
export type ReleaseWriteResult = z.infer<typeof releaseWriteResultSchema>;
export type CustomResource = z.infer<typeof customResourceSchema>;
export type CustomResourceDetail = z.infer<typeof customResourceDetailSchema>;
export type ReleaseStatusKind = z.infer<typeof releaseStatusKindSchema>;
export type ReleaseObjectState = z.infer<typeof releaseObjectStateSchema>;
export type ReleaseObject = z.infer<typeof releaseObjectSchema>;
