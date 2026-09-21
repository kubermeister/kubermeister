import { z } from 'zod';
import { namespaceNameSchema } from './names.js';

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
