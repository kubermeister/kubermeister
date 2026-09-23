import type { KubernetesObject, V1Job, V1JobSpec, V1ObjectMeta, V2MetricSpec } from '@kubernetes/client-node';
import type {
    AutoscalerUpdateInput,
    CronJobSuspendInput,
    CronJobTriggerInput,
    EvictInput,
    JobRetryInput,
    WriteResult,
} from '../../../shared/k8s/write.js';
import { apis } from '../client.js';
import { K8sError, withK8s } from '../errors.js';
import { assertContext } from './write.js';

/*
 * The small writes that run a workload rather than describe it: evicting a pod, running a job
 * again, running a cron job now, and holding its schedule. Each acts on exactly the object the
 * screen named, under the same context stamp every write carries.
 */

/** Labels and annotations the control plane owns; a copy of a job must not carry them. */
const CONTROLLER_LABELS = [
    'controller-uid',
    'batch.kubernetes.io/controller-uid',
    'job-name',
    'batch.kubernetes.io/job-name',
];
const CONTROLLER_ANNOTATIONS = ['kubectl.kubernetes.io/last-applied-configuration', 'batch.kubernetes.io/job-tracking'];

const without = (source: Record<string, string> | undefined, drop: string[]): Record<string, string> | undefined => {
    if (!source) return undefined;
    const kept = Object.fromEntries(Object.entries(source).filter(([key]) => !drop.includes(key)));
    return Object.keys(kept).length > 0 ? kept : undefined;
};

/**
 * Evict one pod. The eviction API is what consults PodDisruptionBudgets, so a budget refusing the
 * eviction surfaces as a refusal the user can read rather than as a pod that quietly went anyway.
 */
export function evictPod(input: EvictInput): Promise<WriteResult> {
    const op = 'pods.evict';
    return withK8s(op, async () => {
        assertContext(input.context, op);
        await apis().core.createNamespacedPodEviction({
            name: input.name,
            namespace: input.namespace,
            body: {
                apiVersion: 'policy/v1',
                kind: 'Eviction',
                metadata: { name: input.name, namespace: input.namespace },
                deleteOptions:
                    input.gracePeriodSeconds === undefined
                        ? undefined
                        : { gracePeriodSeconds: input.gracePeriodSeconds },
            },
        });
        return { kind: 'Pod', name: input.name, namespace: input.namespace };
    });
}

/**
 * A job to submit, built from one that already ran. The control plane stamps a job with a selector
 * and matching pod labels derived from its uid; copying those would tie the new job to the old
 * one's pods, so they go, along with the status and every field that described that run.
 */
export function jobFromTemplate(source: V1Job, name: string, metadata: V1ObjectMeta = {}): V1Job {
    const spec = structuredClone(source.spec) as V1JobSpec;
    delete spec.selector;
    delete spec.manualSelector;
    const template = spec.template.metadata;
    if (template) {
        template.labels = without(template.labels, CONTROLLER_LABELS);
        template.annotations = without(template.annotations, CONTROLLER_ANNOTATIONS);
    }
    return {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
            name,
            namespace: source.metadata?.namespace,
            labels: without(source.metadata?.labels, CONTROLLER_LABELS),
            annotations: without(source.metadata?.annotations, CONTROLLER_ANNOTATIONS),
            ...metadata,
        },
        spec,
    };
}

/**
 * Run a job again: the old one is deleted and a job with the same name and spec submitted in its
 * place, which is the only way to rerun one — a job's spec is immutable once it has run. Its pods
 * go with it, so the new run starts clean.
 */
export function retryJob(input: JobRetryInput): Promise<WriteResult> {
    const op = 'jobs.retry';
    // Three calls and a wait for the name to come free: the default read ceiling would cut this
    // short and report a timeout where the real answer is "the old run is still going".
    return withK8s(
        op,
        async () => {
            assertContext(input.context, op);
            const existing = await apis().batch.readNamespacedJob({ name: input.name, namespace: input.namespace });
            const replacement = jobFromTemplate(existing, input.name);
            // Foreground deletion: the API server keeps the name until the pods are gone, so the
            // create below cannot race a half-deleted job into an "already exists" failure.
            await apis().batch.deleteNamespacedJob({
                name: input.name,
                namespace: input.namespace,
                propagationPolicy: 'Foreground',
            });
            await waitForJobGone(input.name, input.namespace, op);
            await apis().batch.createNamespacedJob({ namespace: input.namespace, body: replacement });
            return { kind: 'Job', name: input.name, namespace: input.namespace };
        },
        RETRY_TIMEOUT_MS,
    );
}

/** Ceiling on the whole retry: the delete, the wait for the name, and the resubmission. */
const RETRY_TIMEOUT_MS = 45_000;

/** How long to wait for a deleted job's name to come free before giving up on the retry. */
const GONE_TIMEOUT_MS = 20_000;
const GONE_POLL_MS = 500;

async function waitForJobGone(name: string, namespace: string, op: string): Promise<void> {
    const deadline = Date.now() + GONE_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const still = await apis()
            .batch.readNamespacedJob({ name, namespace })
            .then(() => true)
            .catch(() => false);
        if (!still) return;
        await new Promise((resolve) => setTimeout(resolve, GONE_POLL_MS));
    }
    throw new K8sError(
        'conflict',
        `Job "${name}" is still being deleted. Wait for its pods to finish and try again.`,
        op,
    );
}

/** A name for a manually triggered run, stamped with the minute so two triggers never collide. */
export function manualJobName(cronJob: string, now = new Date()): string {
    const stamp = now.toISOString().replace(/[-:T]/g, '').slice(2, 12);
    return `${cronJob}-${stamp}`.slice(0, 63);
}

/**
 * Run a cron job now. The job is created from the cron job's own template but owned by nobody, so
 * the schedule's history limits never sweep it away and it stays until deleted, which is what a
 * manual run is for.
 */
export function triggerCronJob(input: CronJobTriggerInput): Promise<WriteResult> {
    const op = 'cronJobs.trigger';
    return withK8s(op, async () => {
        assertContext(input.context, op);
        const cronJob = await apis().batch.readNamespacedCronJob({ name: input.name, namespace: input.namespace });
        const template = cronJob.spec?.jobTemplate;
        if (!template?.spec) {
            throw new K8sError('invalid', `CronJob "${input.name}" has no job template to run.`, op);
        }
        const name = manualJobName(input.name);
        const job = jobFromTemplate(
            { apiVersion: 'batch/v1', kind: 'Job', metadata: template.metadata, spec: template.spec },
            name,
            { namespace: input.namespace },
        );
        const created = await apis().batch.createNamespacedJob({ namespace: input.namespace, body: job });
        return { kind: 'Job', name: created.metadata?.name ?? name, namespace: input.namespace };
    });
}

/** A patch that touches nothing but the schedule's suspend flag. */
interface SuspendPatch extends KubernetesObject {
    spec: { suspend: boolean };
}

/** Hold a cron job's schedule, or let it run again. Jobs already running are left alone. */
export function setCronJobSuspended(input: CronJobSuspendInput): Promise<WriteResult> {
    const op = 'cronJobs.suspend';
    return withK8s(op, async () => {
        assertContext(input.context, op);
        const patch: SuspendPatch = {
            apiVersion: 'batch/v1',
            kind: 'CronJob',
            metadata: { name: input.name, namespace: input.namespace },
            spec: { suspend: input.suspend },
        };
        await apis().objects.patch(patch);
        return { kind: 'CronJob', name: input.name, namespace: input.namespace };
    });
}

/** A patch that touches nothing but an autoscaler's bounds and its CPU target. */
interface AutoscalerPatch extends KubernetesObject {
    spec: {
        minReplicas: number;
        maxReplicas: number;
        metrics?: V2MetricSpec[];
    };
}

/** The autoscaler's metrics with the CPU utilisation target set, every other metric left where it was. */
export function withCpuTarget(metrics: readonly V2MetricSpec[], averageUtilization: number): V2MetricSpec[] {
    const cpu: V2MetricSpec = {
        type: 'Resource',
        resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization } },
    };
    const at = metrics.findIndex((metric) => metric.type === 'Resource' && metric.resource?.name === 'cpu');
    return at === -1 ? [...metrics, cpu] : metrics.map((metric, index) => (index === at ? cpu : metric));
}

/**
 * Adjust an autoscaler's bounds, and its CPU target when the caller asked to change it. The
 * metrics list is atomic, so any patch that names it replaces all of it: the CPU target is
 * therefore sent inside the whole list as the autoscaler holds it, read first and changed in that
 * one entry, and carries the resourceVersion that read saw, so a list somebody changed in between
 * is a conflict rather than a silent overwrite. Without a CPU target to set, the metrics are not
 * sent at all and an HPA watching something else keeps watching it.
 */
export function updateAutoscaler(input: AutoscalerUpdateInput): Promise<WriteResult> {
    const op = 'autoscalers.update';
    return withK8s(op, async () => {
        assertContext(input.context, op);
        const metadata: V1ObjectMeta = { name: input.name, namespace: input.namespace };
        const patch: AutoscalerPatch = {
            apiVersion: 'autoscaling/v2',
            kind: 'HorizontalPodAutoscaler',
            metadata,
            spec: { minReplicas: input.minReplicas, maxReplicas: input.maxReplicas },
        };
        if (input.targetCpuPercent !== undefined) {
            const current = await apis().hpa.readNamespacedHorizontalPodAutoscaler({
                name: input.name,
                namespace: input.namespace,
            });
            if (current.metadata?.resourceVersion) metadata.resourceVersion = current.metadata.resourceVersion;
            patch.spec.metrics = withCpuTarget(current.spec?.metrics ?? [], input.targetCpuPercent);
        }
        await apis().objects.patch(patch);
        return { kind: 'HorizontalPodAutoscaler', name: input.name, namespace: input.namespace };
    });
}
