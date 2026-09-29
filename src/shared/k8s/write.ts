import { z } from 'zod';
import {
    isManifestKind,
    manifestKindOf,
    manifestKindSchema,
    refineManifestTarget,
    type ManifestKind,
} from './manifest.js';
import { namespaceNameSchema } from './names.js';
import { kindSchema, restartKindSchema } from './registry.js';

/** What a write reports back: enough to name the object in a toast and invalidate its screens. */
export const writeResultSchema = z.object({
    kind: z.string(),
    name: z.string(),
    namespace: z.string().optional(),
});

/**
 * Every write names the context the screen believes is active. Main compares it with the context
 * it is really on and refuses a mismatch, so a write issued from rows that were rendered before a
 * context switch can never land in the cluster the switch moved to.
 */
const scopeStamp = { context: z.string().min(1) };

/**
 * The manifest kind an edited object's identity names. With its `apiVersion` the group has to match
 * too, since a custom resource may share a built-in kind's name (Longhorn's `Node`); without one the
 * kind is read as the app's own vocabulary. A custom resource answers undefined.
 */
export function identityKind(target: { apiVersion?: string; kind: string }): ManifestKind | undefined {
    if (target.apiVersion !== undefined) return manifestKindOf(target.apiVersion, target.kind);
    return isManifestKind(target.kind) ? target.kind : undefined;
}

/** The object a manifest edit started from; a save whose manifest names anything else is refused. */
export const manifestIdentitySchema = z
    .object({
        /** The object's apiVersion as it was read, which tells a custom resource from a built-in kind. */
        apiVersion: z.string().min(1).optional(),
        /** A registered kind, or the kind of a custom resource the app has no registry entry for. */
        kind: z.string().min(1),
        name: z.string().min(1),
        namespace: namespaceNameSchema.optional(),
    })
    // Only a kind the app knows has a scope to check against; for a custom resource, naming a
    // namespace or not is what its own definition decided, and the identity just records it.
    .superRefine((target, ctx) => {
        const kind = identityKind(target);
        if (kind) refineManifestTarget({ kind, namespace: target.namespace }, ctx);
    });

export const manifestWriteSchema = z.object({
    ...scopeStamp,
    manifest: z.string().min(1),
    /** Run the object through admission without persisting it. */
    dryRun: z.boolean().optional(),
    /** For a replace: the object being edited, pinned so the manifest cannot be aimed elsewhere. */
    expect: manifestIdentitySchema.optional(),
});

export const deleteInputSchema = z
    .object({
        ...scopeStamp,
        kind: manifestKindSchema,
        name: z.string().min(1),
        namespace: namespaceNameSchema.optional(),
        /**
         * Seconds the object gets to shut down, overriding its own grace period. Zero is a forced
         * delete: the API server stops waiting and the record goes, whatever the kubelet is doing.
         */
        gracePeriodSeconds: z.number().int().min(0).max(3600).optional(),
    })
    .superRefine(refineManifestTarget);

export const scaleInputSchema = z
    .object({
        ...scopeStamp,
        kind: kindSchema,
        name: z.string().min(1),
        namespace: namespaceNameSchema.optional(),
        replicas: z.number().int().min(0).max(1000),
    })
    .superRefine(refineManifestTarget);

/**
 * A rollout restart. Every restartable kind is namespaced, so the screen must name the namespace it
 * rendered: the active selection is never consulted for a write that replaces running pods.
 */
export const restartInputSchema = z.object({
    ...scopeStamp,
    kind: restartKindSchema,
    name: z.string().min(1),
    namespace: namespaceNameSchema,
});

/**
 * A rollback names the revision it is aiming at, as the rollout history shows it. Deployments are
 * namespaced, so the screen names the namespace it rendered rather than leaning on the selection.
 */
export const rollbackInputSchema = z.object({
    ...scopeStamp,
    name: z.string().min(1),
    namespace: namespaceNameSchema,
    /** Revision number as the history displays it, e.g. "3". */
    revision: z.string().regex(/^\d+$/, 'must be a revision number'),
});

/**
 * What a rollback did. A revision whose pod template already matches the live one is reported as
 * skipped rather than written, which is how kubectl reads it too: there is nothing to roll back to.
 */
export const rollbackResultSchema = writeResultSchema.extend({
    revision: z.string(),
    skipped: z.boolean(),
});

/** Hold a rollout where it stands, or let it continue. */
export const pauseInputSchema = z.object({
    ...scopeStamp,
    name: z.string().min(1),
    namespace: namespaceNameSchema,
    paused: z.boolean(),
});

/**
 * Cordon or uncordon one node. Nodes are cluster-scoped, so no namespace is named, and the flag is
 * absolute rather than a toggle: a screen acting on a stale reading cannot flip the node the wrong
 * way, it can only ask for the state it displayed.
 */
export const cordonInputSchema = z.object({
    ...scopeStamp,
    name: z.string().min(1),
    unschedulable: z.boolean(),
});

/** One pod, named by the screen that displayed it; used by the writes that act on a single pod. */
const podTarget = {
    ...scopeStamp,
    name: z.string().min(1),
    namespace: namespaceNameSchema,
};

/**
 * Evicting asks the API server to remove a pod the way a drain does, so PodDisruptionBudgets get a
 * say. It is the gentle alternative to deleting: a budget can refuse it, and that refusal is the
 * point rather than an error to work around.
 */
export const evictInputSchema = z.object({
    ...podTarget,
    gracePeriodSeconds: z.number().int().min(0).max(3600).optional(),
});

/** Run a job again from the spec it was created with. */
export const jobRetryInputSchema = z.object(podTarget);

/** Create a job now from a cron job's template, without waiting for its schedule. */
export const cronJobTriggerInputSchema = z.object(podTarget);

/** Hold a cron job's schedule, or let it run again. */
export const cronJobSuspendInputSchema = z.object({ ...podTarget, suspend: z.boolean() });

/**
 * The three numbers an autoscaler is usually adjusted by. Anything else about an HPA — which
 * metrics it watches, its behaviour policies — stays in the manifest editor, where the shape of
 * what is being changed is visible.
 */
export const autoscalerUpdateSchema = z
    .object({
        ...scopeStamp,
        name: z.string().min(1),
        namespace: namespaceNameSchema,
        minReplicas: z.number().int().min(1).max(1000),
        maxReplicas: z.number().int().min(1).max(1000),
        /** Target average CPU utilisation as a percentage; omitted leaves the metric as it is. */
        targetCpuPercent: z.number().int().min(1).max(1000).optional(),
    })
    .refine((input) => input.maxReplicas >= input.minReplicas, {
        path: ['maxReplicas'],
        message: 'must be at least the minimum',
    });

export type WriteResult = z.infer<typeof writeResultSchema>;
export type ManifestIdentity = z.infer<typeof manifestIdentitySchema>;
export type ManifestWrite = z.infer<typeof manifestWriteSchema>;
export type DeleteInput = z.infer<typeof deleteInputSchema>;
export type ScaleInput = z.infer<typeof scaleInputSchema>;
export type RestartInput = z.infer<typeof restartInputSchema>;
export type RollbackInput = z.infer<typeof rollbackInputSchema>;
export type RollbackResult = z.infer<typeof rollbackResultSchema>;
export type PauseInput = z.infer<typeof pauseInputSchema>;
export type CordonInput = z.infer<typeof cordonInputSchema>;
export type EvictInput = z.infer<typeof evictInputSchema>;
export type JobRetryInput = z.infer<typeof jobRetryInputSchema>;
export type CronJobTriggerInput = z.infer<typeof cronJobTriggerInputSchema>;
export type CronJobSuspendInput = z.infer<typeof cronJobSuspendInputSchema>;
export type AutoscalerUpdateInput = z.infer<typeof autoscalerUpdateSchema>;
