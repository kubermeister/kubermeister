import { z } from 'zod';
import { namespaceNameSchema } from './names.js';

const pairs = z.array(z.tuple([z.string(), z.string()]));

/**
 * Display status derived from a Deployment's replica counts. Scaled to zero is a settled state and
 * reads Available rather than Progressing forever. A paused rollout outranks every count: it will
 * not converge on its own, so reporting it as Progressing would promise movement that never comes.
 */
export const deploymentStatusSchema = z.enum(['Available', 'Healthy', 'Progressing', 'Paused']);

export const deploymentSchema = z.object({
    name: z.string(),
    namespace: z.string(),
    status: deploymentStatusSchema,
    /** Ready replicas over desired, e.g. "2/3". */
    ready: z.string(),
    replicas: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    strategy: z.string(),
    /** First container image, or a dash. */
    image: z.string(),
    /** Whether the rollout is held: the controller makes no progress until it is resumed. */
    paused: z.boolean(),
    age: z.string(),
});
export const deploymentDetailSchema = deploymentSchema.extend({ labels: pairs, annotations: pairs });

export const statefulSetSchema = z.object({
    name: z.string(),
    namespace: z.string(),
    ready: z.string(),
    replicas: z.number().int().nonnegative(),
    service: z.string(),
    image: z.string(),
    age: z.string(),
});
export const statefulSetDetailSchema = statefulSetSchema.extend({ labels: pairs, annotations: pairs });

export const daemonSetSchema = z.object({
    name: z.string(),
    namespace: z.string(),
    desired: z.number().int().nonnegative(),
    current: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    upToDate: z.number().int().nonnegative(),
    nodeSelector: z.string(),
    age: z.string(),
});
export const daemonSetDetailSchema = daemonSetSchema.extend({ labels: pairs, annotations: pairs });

export const rolloutStateSchema = z.enum(['Current', 'Superseded']);

/** Two revisions' pod templates, formatted identically so a textual difference is a real one. */
export const rolloutComparisonSchema = z.object({
    from: z.object({ rev: z.string(), yaml: z.string() }),
    to: z.object({ rev: z.string(), yaml: z.string() }),
});

export const rolloutCompareInputSchema = z.object({
    name: z.string().min(1),
    namespace: namespaceNameSchema,
    from: z.string().min(1),
    to: z.string().min(1),
});

/** One revision of a Deployment, synthesised from an owned ReplicaSet. */
export const rolloutSchema = z.object({
    /** Revision number, e.g. "3". */
    rev: z.string(),
    state: rolloutStateSchema,
    image: z.string(),
    /** The change-cause annotation, or a dash. */
    by: z.string(),
    when: z.string(),
    duration: z.string(),
});

export const replicaSetSchema = z.object({
    name: z.string(),
    desired: z.number().int().nonnegative(),
    current: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    age: z.string(),
});

/** One of the Deployment's conditions, as the API server reports it. */
export const rolloutConditionSchema = z.object({
    type: z.string(),
    /** 'True', 'False' or 'Unknown', kept as the API server's own wording. */
    status: z.string(),
    reason: z.string(),
    message: z.string(),
    when: z.string(),
});

/** A ReplicaSet in the rollout picture: the same row plus where it stands in the rollout. */
export const rolloutReplicaSetSchema = replicaSetSchema.extend({
    rev: z.string(),
    /** The set the Deployment is rolling towards, against the ones it is rolling away from. */
    role: z.enum(['new', 'old']),
});

/**
 * Live progress of a rolling update: the counts the controller moves, the conditions explaining
 * why it is or is not moving, and the pods each generation still holds.
 */
export const rolloutStatusSchema = z.object({
    paused: z.boolean(),
    desired: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    /** Every replica is updated and available: the rollout has nothing left to do. */
    settled: z.boolean(),
    conditions: z.array(rolloutConditionSchema),
    sets: z.array(rolloutReplicaSetSchema),
});

/**
 * A ReplicaSet as its own object rather than as a line in a Deployment's rollout: the same counts,
 * plus where it lives and what owns it, which is the question asked of a replica set on its own.
 */
export const replicaSetRowSchema = replicaSetSchema.extend({
    namespace: z.string(),
    /** `Kind/name` of the controller above it, or a dash for one nobody owns. */
    owner: z.string(),
    image: z.string(),
});
export const replicaSetDetailSchema = replicaSetRowSchema.extend({ labels: pairs, annotations: pairs });

/** A ReplicationController: the same shape, since it is what ReplicaSets replaced. */
export const replicationControllerSchema = replicaSetRowSchema;
export const replicationControllerDetailSchema = replicaSetDetailSchema;

/** A Job is Running until a terminal condition appears; Complete outranks nothing, Failed outranks Complete. */
export const jobStatusSchema = z.enum(['Complete', 'Running', 'Failed']);

export const jobSchema = z.object({
    name: z.string(),
    namespace: z.string(),
    /** Succeeded pods over requested completions, e.g. "1/1". */
    completions: z.string(),
    /** Wall-clock run time, or an em-dash before the job starts. */
    duration: z.string(),
    status: jobStatusSchema,
    age: z.string(),
});
export const jobDetailSchema = jobSchema.extend({ labels: pairs, annotations: pairs });

export const cronJobSchema = z.object({
    name: z.string(),
    namespace: z.string(),
    /** Cron expression, or an em-dash. */
    schedule: z.string(),
    suspend: z.boolean(),
    /** Currently running jobs this cron job owns. */
    active: z.number().int().nonnegative(),
    lastSchedule: z.string(),
    age: z.string(),
});
export const cronJobDetailSchema = cronJobSchema.extend({ labels: pairs, annotations: pairs });

export const autoscalerSchema = z.object({
    name: z.string(),
    namespace: z.string(),
    /** Scale target as `Kind/name`, or an em-dash. */
    reference: z.string(),
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
    replicas: z.number().int().nonnegative(),
    /** Current over target utilisation, e.g. "42% / 80%", or an em-dash when neither is reported. */
    targets: z.string(),
    /** The CPU utilisation target as a number, when this autoscaler watches CPU; null otherwise. */
    targetCpuPercent: z.number().int().nullable(),
    age: z.string(),
});
export const autoscalerDetailSchema = autoscalerSchema.extend({ labels: pairs, annotations: pairs });

export const configMapSchema = z.object({
    name: z.string(),
    namespace: z.string(),
    keys: z.number().int().nonnegative(),
    /** Total size of the data and binary data, humanised. */
    size: z.string(),
    age: z.string(),
});
export const configMapDetailSchema = configMapSchema.extend({ labels: pairs, annotations: pairs });

export const secretSchema = z.object({
    name: z.string(),
    namespace: z.string(),
    type: z.string(),
    keys: z.number().int().nonnegative(),
    age: z.string(),
});
export const secretDetailSchema = secretSchema.extend({ labels: pairs, annotations: pairs });

/** One ConfigMap key with its value; binary keys are counted but not returned. */
export const configMapEntrySchema = z.object({
    key: z.string(),
    /** Guessed from the value's shape: JSON, YAML or plain text. */
    contentType: z.string(),
    size: z.string(),
    value: z.string(),
});

/** One Secret key. Listing a Secret reads no value: only the key name and a fixed mask cross the bridge. */
export const secretEntrySchema = z.object({ key: z.string(), masked: z.string() });

export const namespacedNameSchema = z.object({ name: z.string().min(1), namespace: namespaceNameSchema });

/** The one key a reveal or a copy asks for, so a read never answers the whole map. */
export const secretKeySchema = namespacedNameSchema.extend({ key: z.string().min(1) });

/** One revealed Secret value. Bytes that are not text travel base64 encoded, with `binary` saying so. */
export const secretValueSchema = z.object({ key: z.string(), value: z.string(), binary: z.boolean() });

export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;
export type Deployment = z.infer<typeof deploymentSchema>;
export type DeploymentDetail = z.infer<typeof deploymentDetailSchema>;
export type StatefulSet = z.infer<typeof statefulSetSchema>;
export type StatefulSetDetail = z.infer<typeof statefulSetDetailSchema>;
export type DaemonSet = z.infer<typeof daemonSetSchema>;
export type DaemonSetDetail = z.infer<typeof daemonSetDetailSchema>;
export type RolloutState = z.infer<typeof rolloutStateSchema>;
export type Rollout = z.infer<typeof rolloutSchema>;
export type RolloutComparison = z.infer<typeof rolloutComparisonSchema>;
export type RolloutCompareInput = z.infer<typeof rolloutCompareInputSchema>;
export type ReplicaSet = z.infer<typeof replicaSetSchema>;
export type ReplicaSetRow = z.infer<typeof replicaSetRowSchema>;
export type ReplicaSetDetail = z.infer<typeof replicaSetDetailSchema>;
export type RolloutCondition = z.infer<typeof rolloutConditionSchema>;
export type RolloutReplicaSet = z.infer<typeof rolloutReplicaSetSchema>;
export type RolloutStatus = z.infer<typeof rolloutStatusSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type Job = z.infer<typeof jobSchema>;
export type JobDetail = z.infer<typeof jobDetailSchema>;
export type CronJob = z.infer<typeof cronJobSchema>;
export type CronJobDetail = z.infer<typeof cronJobDetailSchema>;
export type Autoscaler = z.infer<typeof autoscalerSchema>;
export type AutoscalerDetail = z.infer<typeof autoscalerDetailSchema>;
export type ConfigMap = z.infer<typeof configMapSchema>;
export type ConfigMapDetail = z.infer<typeof configMapDetailSchema>;
export type Secret = z.infer<typeof secretSchema>;
export type SecretDetail = z.infer<typeof secretDetailSchema>;
export type ConfigMapEntry = z.infer<typeof configMapEntrySchema>;
export type SecretEntry = z.infer<typeof secretEntrySchema>;
export type SecretKey = z.infer<typeof secretKeySchema>;
export type SecretValue = z.infer<typeof secretValueSchema>;
export type NamespacedName = z.infer<typeof namespacedNameSchema>;
