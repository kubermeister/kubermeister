import { z } from 'zod';
import type { AllowedChannel } from './ipc-channels.js';
import {
    helmChartSchema,
    releaseRevisionSchema,
    releaseRollbackInputSchema,
    releaseSchema,
    releaseTargetSchema,
    releaseUninstallInputSchema,
    releaseWriteResultSchema,
} from './k8s/addons.js';
import { kubeContextSchema } from './k8s/contexts.js';
import { manifestInputSchema, manifestSchema } from './k8s/manifest.js';
import { namespaceDetailInputSchema, namespaceDetailSchema } from './k8s/namespaces.js';
import { objectMetaInputSchema, objectMetaSchema } from './k8s/meta.js';
import { relatedGroupSchema, relatedInputSchema } from './k8s/related.js';
import {
    customResourceGetInputSchema,
    customResourceGetOutputSchema,
    customResourceListInputSchema,
    customResourceListOutputSchema,
} from './k8s/custom.js';
import { describeDocumentSchema, describeInputSchema } from './k8s/describe.js';
import { drainPlanInputSchema, drainPlanSchema } from './k8s/drain.js';
import { ownedPodsInputSchema, ownerChainSchema } from './k8s/owners.js';
import { podSchema } from './k8s/pods.js';
import {
    cordonInputSchema,
    autoscalerUpdateSchema,
    cronJobSuspendInputSchema,
    cronJobTriggerInputSchema,
    deleteInputSchema,
    evictInputSchema,
    jobRetryInputSchema,
    manifestWriteSchema,
    pauseInputSchema,
    restartInputSchema,
    rollbackInputSchema,
    rollbackResultSchema,
    scaleInputSchema,
    writeResultSchema,
} from './k8s/write.js';
import { clusterEventSchema, objectEventsInputSchema } from './k8s/events.js';
import { ingressRuleSchema, serviceEndpointSchema, servicePortSchema } from './k8s/network.js';
import { limitRangeSchema, resourceQuotaSchema } from './k8s/overview.js';
import {
    logLineSchema,
    podLogDownloadInputSchema,
    podLogDownloadSchema,
    podLogSnapshotInputSchema,
} from './k8s/logs.js';
import {
    alertSchema,
    clusterSparklinesSchema,
    deploymentSeriesInputSchema,
    healthPointSchema,
    nodeSeriesInputSchema,
    podSeriesInputSchema,
    resourceSeriesSchema,
} from './k8s/metrics.js';
import { ipcErrorSchema } from './k8s/errors.js';
import { activeNamespaceSchema, clusterSchema, namespaceSchema } from './k8s/cluster.js';
import { namespaceNameSchema } from './k8s/names.js';
import { nodeDetailSchema, nodeSchema } from './k8s/nodes.js';
import {
    resourceGetInputSchema,
    resourceGetOutputSchema,
    resourceListInputSchema,
    resourceListOutputSchema,
} from './k8s/resources.js';
import { settingsInputSchema, settingsSchema } from './settings.js';
import {
    configMapEntrySchema,
    namespacedNameSchema,
    replicaSetSchema,
    rolloutSchema,
    rolloutCompareInputSchema,
    rolloutComparisonSchema,
    rolloutStatusSchema,
    secretEntrySchema,
    secretKeySchema,
    secretValueSchema,
} from './k8s/workloads.js';

const noInput = z.object({});

const appInfoSchema = z.object({
    name: z.string(),
    version: z.string(),
    electron: z.string(),
    chrome: z.string(),
    node: z.string(),
    platform: z.string(),
});

/**
 * Where the in-app updater is. `unsupported` covers development builds and Linux packages that
 * cannot self-update (deb); `available` is a newer version the user has not asked to download yet
 * (the `updates.mode` setting decides whether that step is automatic); `message` carries the
 * unsupported reason or the error text.
 */
export const updateStateSchema = z.object({
    status: z.enum([
        'unsupported',
        'idle',
        'checking',
        'up-to-date',
        'available',
        'downloading',
        'downloaded',
        'error',
    ]),
    /** Version found, being downloaded or ready to install. */
    version: z.string().optional(),
    /** Download progress, 0 to 100. */
    percent: z.number().min(0).max(100).optional(),
    message: z.string().optional(),
    /** When the found version was published, ISO 8601. */
    releaseDate: z.string().optional(),
    /** When the last check finished, ISO 8601. */
    checkedAt: z.string().optional(),
    /** An error from a scheduled check nobody asked for; shown in Settings, never as a notification. */
    background: z.boolean().optional(),
});

/** One startup preflight check. `error` blocks the app, `warning` lets it open. */
const startupCheckSchema = z.object({
    id: z.enum(['kubeconfig', 'context', 'cluster']),
    label: z.string(),
    status: z.enum(['ok', 'warning', 'error']),
    /** What was found, shown to the user as the reason. */
    detail: z.string().optional(),
    /** Actionable remediation shown when the check did not pass. */
    hint: z.string().optional(),
});

const startupReportSchema = z.object({
    checks: z.array(startupCheckSchema),
    /** False when any check is an error. */
    ok: z.boolean(),
});

const namespaceSelectionSchema = z.object({ namespace: namespaceNameSchema.nullable() });

/** Reads scoped to one namespace, or to the active selection when omitted. */
const namespacedListSchema = z.object({ namespace: namespaceNameSchema.optional() });

/**
 * The renderer-to-main contract. Every channel declares its input and output schema; main validates
 * both at the boundary and the renderer recovers the types through `lib/ipc.ts`.
 */
export const ipcSchemas = {
    'app.info': { input: noInput, output: appInfoSchema },
    'update.state': { input: noInput, output: updateStateSchema },
    'update.check': { input: noInput, output: updateStateSchema },
    'update.download': { input: noInput, output: z.object({ ok: z.boolean() }) },
    'update.install': { input: noInput, output: z.object({ ok: z.boolean() }) },
    startupChecks: { input: noInput, output: startupReportSchema },
    'contexts.list': { input: noInput, output: z.array(kubeContextSchema) },
    'context.current': { input: noInput, output: kubeContextSchema.nullable() },
    'context.set': { input: z.object({ name: z.string().min(1) }), output: kubeContextSchema },
    'namespace.set': { input: namespaceSelectionSchema, output: namespaceSelectionSchema },
    'settings.get': { input: noInput, output: settingsSchema },
    'settings.set': { input: settingsInputSchema, output: settingsSchema },
    // Kubeconfig path changes are dialog-gated: the renderer never supplies a path string.
    'kubeconfig.pick': { input: noInput, output: z.object({ path: z.string().nullable() }) },
    'kubeconfig.useDefault': { input: noInput, output: settingsSchema },
    'namespaces.list': { input: noInput, output: z.array(namespaceSchema) },
    'namespace.active': { input: noInput, output: activeNamespaceSchema },
    'cluster.active': { input: noInput, output: clusterSchema.nullable() },
    'clusters.list': { input: noInput, output: z.array(clusterSchema) },
    'nodes.list': { input: noInput, output: z.array(nodeSchema) },
    'nodes.get': { input: z.object({ name: z.string().min(1) }), output: nodeDetailSchema.nullable() },
    'nodes.cordon': { input: cordonInputSchema, output: writeResultSchema },
    'nodes.drainPlan': { input: drainPlanInputSchema, output: drainPlanSchema },
    'resources.list': { input: resourceListInputSchema, output: resourceListOutputSchema },
    'resources.get': { input: resourceGetInputSchema, output: resourceGetOutputSchema },
    'pods.owners': { input: namespacedNameSchema, output: ownerChainSchema },
    'workloads.pods': { input: ownedPodsInputSchema, output: z.array(podSchema) },
    'pods.logSnapshot': { input: podLogSnapshotInputSchema, output: z.array(logLineSchema) },
    'pods.logDownload': { input: podLogDownloadInputSchema, output: podLogDownloadSchema },
    'events.forObject': { input: objectEventsInputSchema, output: z.array(clusterEventSchema) },
    'events.recent': { input: noInput, output: z.array(clusterEventSchema) },
    'events.list': { input: namespacedListSchema, output: z.array(clusterEventSchema) },
    'quotas.list': { input: namespacedListSchema, output: z.array(resourceQuotaSchema) },
    'limits.list': { input: namespacedListSchema, output: z.array(limitRangeSchema) },
    'metrics.sparklines': { input: noInput, output: clusterSparklinesSchema },
    'metrics.workloadHealth': { input: noInput, output: z.array(healthPointSchema) },
    'metrics.alerts': { input: noInput, output: z.array(alertSchema) },
    'metrics.podSeries': { input: podSeriesInputSchema, output: resourceSeriesSchema },
    'metrics.nodeSeries': { input: nodeSeriesInputSchema, output: resourceSeriesSchema },
    'metrics.deploymentSeries': { input: deploymentSeriesInputSchema, output: resourceSeriesSchema },
    'deployments.replicaSets': { input: namespacedNameSchema, output: z.array(replicaSetSchema) },
    'deployments.rollouts': { input: namespacedNameSchema, output: z.array(rolloutSchema) },
    'deployments.rolloutStatus': { input: namespacedNameSchema, output: rolloutStatusSchema.nullable() },
    'deployments.rollback': { input: rollbackInputSchema, output: rollbackResultSchema },
    'deployments.pause': { input: pauseInputSchema, output: writeResultSchema },
    'deployments.compare': { input: rolloutCompareInputSchema, output: rolloutComparisonSchema },
    'configMaps.entries': { input: namespacedNameSchema, output: z.array(configMapEntrySchema) },
    'secrets.entries': { input: namespacedNameSchema, output: z.array(secretEntrySchema) },
    'secrets.reveal': { input: secretKeySchema, output: secretValueSchema.nullable() },
    'services.ports': { input: namespacedNameSchema, output: z.array(servicePortSchema) },
    'services.endpoints': { input: namespacedNameSchema, output: z.array(serviceEndpointSchema) },
    'ingresses.rules': { input: namespacedNameSchema, output: z.array(ingressRuleSchema) },
    'releases.list': { input: noInput, output: z.array(releaseSchema) },
    'releases.get': { input: releaseTargetSchema, output: releaseSchema.nullable() },
    'releases.revisions': { input: releaseTargetSchema, output: z.array(releaseRevisionSchema) },
    'releases.rollback': { input: releaseRollbackInputSchema, output: releaseWriteResultSchema },
    'releases.uninstall': { input: releaseUninstallInputSchema, output: releaseWriteResultSchema },
    'helmCharts.list': { input: noInput, output: z.array(helmChartSchema) },
    'namespaces.detail': { input: namespaceDetailInputSchema, output: namespaceDetailSchema.nullable() },
    'customResources.list': { input: customResourceListInputSchema, output: customResourceListOutputSchema },
    'customResources.get': { input: customResourceGetInputSchema, output: customResourceGetOutputSchema },
    'customResources.getYaml': { input: customResourceGetInputSchema, output: manifestSchema },
    'resources.meta': { input: objectMetaInputSchema, output: objectMetaSchema },
    'resources.related': { input: relatedInputSchema, output: z.array(relatedGroupSchema) },
    'resources.getYaml': { input: manifestInputSchema, output: manifestSchema },
    'resources.describe': { input: describeInputSchema, output: describeDocumentSchema },
    'resources.create': { input: manifestWriteSchema, output: writeResultSchema },
    'resources.replace': { input: manifestWriteSchema, output: writeResultSchema },
    'resources.delete': { input: deleteInputSchema, output: writeResultSchema },
    'resources.scale': { input: scaleInputSchema, output: writeResultSchema },
    'resources.restart': { input: restartInputSchema, output: writeResultSchema },
    'pods.evict': { input: evictInputSchema, output: writeResultSchema },
    'jobs.retry': { input: jobRetryInputSchema, output: writeResultSchema },
    'cronJobs.trigger': { input: cronJobTriggerInputSchema, output: writeResultSchema },
    'cronJobs.suspend': { input: cronJobSuspendInputSchema, output: writeResultSchema },
    'autoscalers.update': { input: autoscalerUpdateSchema, output: writeResultSchema },
} as const;

/**
 * Every invoke resolves to this envelope. Expected failures (a classified cluster error) travel as
 * `ok: false` with structure the renderer can act on; unexpected exceptions still reject the
 * invoke, since those are bugs. The registry validates `data` against the channel's output schema.
 */
export const ipcResultSchema = z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: z.unknown() }),
    z.object({ ok: z.literal(false), error: ipcErrorSchema }),
]);

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: z.infer<typeof ipcErrorSchema> };

export type IpcSchemas = typeof ipcSchemas;
export type IpcChannel = keyof IpcSchemas;
export type IpcInput<C extends IpcChannel> = z.infer<IpcSchemas[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.infer<IpcSchemas[C]['output']>;

export type AppInfo = z.infer<typeof appInfoSchema>;
export type UpdateState = z.infer<typeof updateStateSchema>;
export type StartupCheck = z.infer<typeof startupCheckSchema>;
export type StartupReport = z.infer<typeof startupReportSchema>;

// A channel added to one list but not the other is a type error, not a silent runtime gap.
type Assert<T extends true> = T;
type _AllChannelsAllowed = Assert<IpcChannel extends AllowedChannel ? true : false>;
type _NoStrayChannels = Assert<Exclude<AllowedChannel, IpcChannel> extends never ? true : false>;
