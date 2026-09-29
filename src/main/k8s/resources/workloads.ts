import type {
    KubernetesObject,
    V1CronJob,
    V1DaemonSet,
    V1Deployment,
    V1Job,
    V1ReplicaSet,
    V1ReplicationController,
    V1StatefulSet,
    V2HorizontalPodAutoscaler,
} from '@kubernetes/client-node';
import type {
    Autoscaler,
    AutoscalerDetail,
    CronJob,
    CronJobDetail,
    DaemonSet,
    DaemonSetDetail,
    Deployment,
    DeploymentDetail,
    DeploymentStatus,
    Job,
    JobDetail,
    JobStatus,
    ReplicaSet,
    ReplicaSetDetail,
    ReplicaSetRow,
    Rollout,
    RolloutCondition,
    RolloutReplicaSet,
    RolloutStatus,
    StatefulSet,
    StatefulSetDetail,
} from '../../../shared/k8s/workloads.js';
import type { PauseInput, RollbackInput, RollbackResult, WriteResult } from '../../../shared/k8s/write.js';
import type { RolloutComparison, RolloutCompareInput } from '../../../shared/k8s/workloads.js';
import { yamlToText } from '../yaml.js';
import { apis, getNamespaced, listItems } from '../client.js';
import { K8sError, withK8s } from '../errors.js';
import { assertContext } from './write.js';
import { ownerLabel } from './controller.js';
import { age, ago, dash, duration, joinSelector, readyRatio, toPairs } from '../format.js';

/*
 * Pure transforms first, exported for tests and for the watch stream; thin readers at the end.
 */

const firstImage = (containers?: { image?: string }[]): string => dash(containers?.[0]?.image);

/**
 * Scaled to zero is a settled, intentional state, so it reads Available rather than Progressing. A
 * paused rollout is reported as such whatever the counts say: it will not converge until resumed.
 */
export function deploymentStatus(desired: number, available: number, paused = false): DeploymentStatus {
    if (paused) return 'Paused';
    if (desired === 0) return 'Available';
    return available >= desired ? 'Healthy' : 'Progressing';
}

export function toDeployment(d: V1Deployment, now = Date.now()): Deployment {
    const desired = d.spec?.replicas ?? d.status?.replicas ?? 0;
    const available = d.status?.availableReplicas ?? 0;
    const paused = d.spec?.paused === true;
    return {
        name: d.metadata?.name ?? '',
        namespace: d.metadata?.namespace ?? '',
        status: deploymentStatus(desired, available, paused),
        ready: readyRatio(d.status?.readyReplicas, desired),
        replicas: desired,
        updated: d.status?.updatedReplicas ?? 0,
        available,
        strategy: d.spec?.strategy?.type ?? 'RollingUpdate',
        image: firstImage(d.spec?.template?.spec?.containers),
        paused,
        age: age(d.metadata?.creationTimestamp, now),
    };
}

export function toDeploymentDetail(d: V1Deployment, now = Date.now()): DeploymentDetail {
    return {
        ...toDeployment(d, now),
        labels: toPairs(d.metadata?.labels),
        annotations: toPairs(d.metadata?.annotations),
    };
}

export function toStatefulSet(s: V1StatefulSet, now = Date.now()): StatefulSet {
    const desired = s.spec?.replicas ?? s.status?.replicas ?? 0;
    return {
        name: s.metadata?.name ?? '',
        namespace: s.metadata?.namespace ?? '',
        ready: readyRatio(s.status?.readyReplicas, desired),
        replicas: desired,
        service: dash(s.spec?.serviceName),
        image: firstImage(s.spec?.template?.spec?.containers),
        age: age(s.metadata?.creationTimestamp, now),
    };
}

export function toStatefulSetDetail(s: V1StatefulSet, now = Date.now()): StatefulSetDetail {
    return {
        ...toStatefulSet(s, now),
        labels: toPairs(s.metadata?.labels),
        annotations: toPairs(s.metadata?.annotations),
    };
}

export function toDaemonSet(d: V1DaemonSet, now = Date.now()): DaemonSet {
    return {
        name: d.metadata?.name ?? '',
        namespace: d.metadata?.namespace ?? '',
        desired: d.status?.desiredNumberScheduled ?? 0,
        current: d.status?.currentNumberScheduled ?? 0,
        ready: d.status?.numberReady ?? 0,
        upToDate: d.status?.updatedNumberScheduled ?? 0,
        nodeSelector: joinSelector(d.spec?.template?.spec?.nodeSelector),
        age: age(d.metadata?.creationTimestamp, now),
    };
}

export function toDaemonSetDetail(d: V1DaemonSet, now = Date.now()): DaemonSetDetail {
    return {
        ...toDaemonSet(d, now),
        labels: toPairs(d.metadata?.labels),
        annotations: toPairs(d.metadata?.annotations),
    };
}

export function toReplicaSet(rs: V1ReplicaSet, now = Date.now()): ReplicaSet {
    return {
        name: rs.metadata?.name ?? '',
        desired: rs.spec?.replicas ?? 0,
        current: rs.status?.replicas ?? 0,
        ready: rs.status?.readyReplicas ?? 0,
        age: age(rs.metadata?.creationTimestamp, now),
    };
}

/**
 * A ReplicaSet as its own list row. The Deployment screens show the sets they own without a
 * namespace or an owner, since both are the Deployment's; a cluster-wide list needs them.
 */
export function toReplicaSetRow(rs: V1ReplicaSet, now = Date.now()): ReplicaSetRow {
    return {
        ...toReplicaSet(rs, now),
        namespace: rs.metadata?.namespace ?? '',
        owner: ownerLabel(rs.metadata),
        image: firstImage(rs.spec?.template?.spec?.containers),
    };
}

export function toReplicaSetDetail(rs: V1ReplicaSet, now = Date.now()): ReplicaSetDetail {
    return {
        ...toReplicaSetRow(rs, now),
        labels: toPairs(rs.metadata?.labels),
        annotations: toPairs(rs.metadata?.annotations),
    };
}

/**
 * The ReplicationController predates ReplicaSets and is still what a few old charts ship. It
 * carries the same counts under the same names, so it renders as the same row.
 */
export function toReplicationController(rc: V1ReplicationController, now = Date.now()): ReplicaSetRow {
    return {
        name: rc.metadata?.name ?? '',
        namespace: rc.metadata?.namespace ?? '',
        owner: ownerLabel(rc.metadata),
        desired: rc.spec?.replicas ?? 0,
        current: rc.status?.replicas ?? 0,
        ready: rc.status?.readyReplicas ?? 0,
        image: firstImage(rc.spec?.template?.spec?.containers),
        age: age(rc.metadata?.creationTimestamp, now),
    };
}

export function toReplicationControllerDetail(rc: V1ReplicationController, now = Date.now()): ReplicaSetDetail {
    return {
        ...toReplicationController(rc, now),
        labels: toPairs(rc.metadata?.labels),
        annotations: toPairs(rc.metadata?.annotations),
    };
}

const REVISION_ANNOTATION = 'deployment.kubernetes.io/revision';
const CHANGE_CAUSE_ANNOTATION = 'kubernetes.io/change-cause';

/** The ReplicaSets a Deployment owns, by owner reference uid. */
export function ownedReplicaSets(deployment: V1Deployment, sets: V1ReplicaSet[]): V1ReplicaSet[] {
    const uid = deployment.metadata?.uid;
    return sets.filter((rs) => rs.metadata?.ownerReferences?.some((ref) => ref.uid === uid));
}

/** Rollout history from owned ReplicaSets, newest revision first; the deployment's revision is Current. */
export function toRollouts(deployment: V1Deployment, sets: V1ReplicaSet[], now = Date.now()): Rollout[] {
    const currentRevision = deployment.metadata?.annotations?.[REVISION_ANNOTATION];
    return ownedReplicaSets(deployment, sets)
        .map((rs) => ({ rs, revision: rs.metadata?.annotations?.[REVISION_ANNOTATION] ?? '0' }))
        .sort((a, b) => Number(b.revision) - Number(a.revision))
        .map(({ rs, revision }) => ({
            rev: revision,
            state: revision === currentRevision ? 'Current' : 'Superseded',
            image: firstImage(rs.spec?.template?.spec?.containers),
            by: dash(rs.metadata?.annotations?.[CHANGE_CAUSE_ANNOTATION]),
            when: ago(rs.metadata?.creationTimestamp, now),
            duration: duration(rs.metadata?.creationTimestamp, undefined),
        }));
}

/** The revision a ReplicaSet carries; sets created before the annotation existed read as revision 0. */
function revisionOf(rs: V1ReplicaSet): string {
    return rs.metadata?.annotations?.[REVISION_ANNOTATION] ?? '0';
}

/** The label the Deployment controller maintains on every generation it creates. */
const POD_TEMPLATE_HASH_LABEL = 'pod-template-hash';

/**
 * Live progress of a rolling update: the counts the controller moves, the conditions explaining why
 * it is or is not moving, and the pods each generation still holds. The set matching the
 * Deployment's own revision is the one being rolled towards; the rest are being drained.
 */
export function toRolloutStatus(d: V1Deployment, sets: V1ReplicaSet[], now = Date.now()): RolloutStatus {
    const desired = d.spec?.replicas ?? d.status?.replicas ?? 0;
    const updated = d.status?.updatedReplicas ?? 0;
    const available = d.status?.availableReplicas ?? 0;
    const currentRevision = d.metadata?.annotations?.[REVISION_ANNOTATION];
    const conditions: RolloutCondition[] = (d.status?.conditions ?? []).map((c) => ({
        type: c.type,
        status: c.status,
        reason: dash(c.reason),
        message: dash(c.message),
        when: ago(c.lastTransitionTime, now),
    }));
    const rollingSets: RolloutReplicaSet[] = ownedReplicaSets(d, sets)
        .map((rs) => ({ rs, rev: revisionOf(rs) }))
        .sort((a, b) => Number(b.rev) - Number(a.rev))
        .map(({ rs, rev }) => ({
            ...toReplicaSet(rs, now),
            rev,
            role: rev === currentRevision ? ('new' as const) : ('old' as const),
        }));
    return {
        paused: d.spec?.paused === true,
        desired,
        updated,
        ready: d.status?.readyReplicas ?? 0,
        available,
        unavailable: d.status?.unavailableReplicas ?? 0,
        settled: updated === desired && available >= desired && (d.status?.unavailableReplicas ?? 0) === 0,
        conditions,
        sets: rollingSets,
    };
}

/**
 * Annotations that describe a ReplicaSet's place in the rollout rather than the Deployment's own
 * intent. A rollback keeps the Deployment's values for these and takes everything else from the
 * revision it restores, so rolling back cannot rewrite the rollout's own bookkeeping.
 */
const ROLLOUT_OWNED_ANNOTATIONS = new Set([
    'kubectl.kubernetes.io/last-applied-configuration',
    'deployment.kubernetes.io/revision',
    'deployment.kubernetes.io/revision-history',
    'deployment.kubernetes.io/desired-replicas',
    'deployment.kubernetes.io/max-replicas',
    'deprecated.deployment.rollback.to',
]);

/** The pod template of a revision, without the hash label the controller adds to every generation. */
export function templateForRollback(rs: V1ReplicaSet): NonNullable<V1ReplicaSet['spec']>['template'] {
    const template = structuredClone(rs.spec?.template ?? {});
    if (template.metadata?.labels) delete template.metadata.labels[POD_TEMPLATE_HASH_LABEL];
    return template;
}

/** The annotations a rolled-back Deployment ends up with. */
export function annotationsForRollback(d: V1Deployment, rs: V1ReplicaSet): Record<string, string> {
    const annotations: Record<string, string> = {};
    for (const key of ROLLOUT_OWNED_ANNOTATIONS) {
        const own = d.metadata?.annotations?.[key];
        if (own !== undefined) annotations[key] = own;
    }
    for (const [key, value] of Object.entries(rs.metadata?.annotations ?? {})) {
        if (!ROLLOUT_OWNED_ANNOTATIONS.has(key)) annotations[key] = value;
    }
    return annotations;
}

/** An absent field, an empty map and an empty list all say the same thing about a pod template. */
function isBlank(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (Array.isArray(value)) return value.length === 0;
    return typeof value === 'object' && Object.keys(value as object).length === 0;
}

/**
 * A pod template reduced to what it actually says: keys in a fixed order and blanks dropped. The
 * API server fills templates out differently depending on where they are read from — a Deployment's
 * own template and the copy its ReplicaSet carries differ in empty maps and key order alone — so
 * comparing them literally would call every revision different from every other.
 */
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .map(([key, item]) => [key, canonical(item)] as const)
                .filter(([, item]) => !isBlank(item))
                .sort(([a], [b]) => a.localeCompare(b)),
        );
    }
    return value;
}

/** Whether two pod templates differ by anything more than the controller's own hash label. */
export function sameTemplate(a?: V1Deployment['spec'], b?: V1ReplicaSet['spec']): boolean {
    const strip = (template: unknown) => {
        const copy = structuredClone(template ?? null) as { metadata?: { labels?: Record<string, string> } } | null;
        if (copy?.metadata?.labels) delete copy.metadata.labels[POD_TEMPLATE_HASH_LABEL];
        return JSON.stringify(canonical(copy));
    };
    return strip(a?.template) === strip(b?.template);
}

/**
 * The rollback itself, as a JSON patch. The template is replaced rather than merged: a strategic
 * merge would merge container lists by name, so a container or an environment variable added after
 * the target revision would survive the rollback it is supposed to undo.
 */
export function rollbackPatch(d: V1Deployment, rs: V1ReplicaSet): { op: string; path: string; value: unknown }[] {
    return [
        { op: 'replace', path: '/spec/template', value: templateForRollback(rs) },
        { op: 'replace', path: '/metadata/annotations', value: annotationsForRollback(d, rs) },
    ];
}

export function listDeployments(namespace?: string): Promise<Deployment[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().apps.listNamespacedDeployment({ namespace: ns }),
            () => apis().apps.listDeploymentForAllNamespaces(),
        );
        return items.map((d) => toDeployment(d));
    });
}

function readDeployment(name: string, namespace?: string): Promise<V1Deployment | undefined> {
    return getNamespaced(name, namespace, (n, ns) => apis().apps.readNamespacedDeployment({ name: n, namespace: ns }));
}

export function getDeployment(name: string, namespace?: string): Promise<DeploymentDetail | null> {
    return withK8s('resources.get', async () => {
        const d = await readDeployment(name, namespace);
        return d ? toDeploymentDetail(d) : null;
    });
}

async function replicaSetsOf(deployment: V1Deployment): Promise<V1ReplicaSet[]> {
    const ns = deployment.metadata?.namespace;
    if (!ns) return [];
    const res = await apis().apps.listNamespacedReplicaSet({ namespace: ns });
    return ownedReplicaSets(deployment, res.items);
}

export function getDeploymentReplicaSets(name: string, namespace: string): Promise<ReplicaSet[]> {
    return withK8s('deployments.replicaSets', async () => {
        const d = await readDeployment(name, namespace);
        if (!d) return [];
        return (await replicaSetsOf(d)).map((rs) => toReplicaSet(rs));
    });
}

export function getDeploymentRollouts(name: string, namespace: string): Promise<Rollout[]> {
    return withK8s('deployments.rollouts', async () => {
        const d = await readDeployment(name, namespace);
        if (!d) return [];
        return toRollouts(d, await replicaSetsOf(d));
    });
}

/**
 * Two revisions' pod templates, side by side. Both go through the same canonicalisation the
 * rollback skip check uses — keys ordered, blanks dropped, the controller's own hash label ignored
 * — so the difference on screen is what somebody changed rather than what the API server filled in.
 */
export function compareDeploymentRevisions(input: RolloutCompareInput): Promise<RolloutComparison> {
    const op = 'deployments.compare';
    return withK8s(op, async () => {
        const d = await readDeployment(input.name, input.namespace);
        if (!d) throw new K8sError('notFound', `Deployment "${input.name}" was not found.`, op);
        const sets = ownedReplicaSets(d, await replicaSetsOf(d));
        const find = (revision: string) => sets.find((rs) => revisionOf(rs) === revision);
        const from = find(input.from);
        const to = find(input.to);
        if (!from || !to) {
            const missing = from ? input.to : input.from;
            throw new K8sError('notFound', `Revision ${missing} of "${input.name}" is no longer kept.`, op);
        }
        const render = (rs: V1ReplicaSet) => yamlToText(canonical(templateForRollback(rs)) as object);
        return {
            from: { rev: input.from, yaml: render(from) },
            to: { rev: input.to, yaml: render(to) },
        };
    });
}

export function getDeploymentRolloutStatus(name: string, namespace: string): Promise<RolloutStatus | null> {
    return withK8s('deployments.rolloutStatus', async () => {
        const d = await readDeployment(name, namespace);
        if (!d) return null;
        return toRolloutStatus(d, await replicaSetsOf(d));
    });
}

/** A patch that touches nothing but the rollout's pause flag. */
interface PausePatch extends KubernetesObject {
    spec: { paused: boolean };
}

/** The deployment a write names, or a classified error: a write never falls back to another object. */
async function readDeploymentForWrite(name: string, namespace: string, op: string): Promise<V1Deployment> {
    const d = await readDeployment(name, namespace);
    if (!d) throw new K8sError('notFound', `Deployment "${name}" was not found in namespace ${namespace}.`, op);
    return d;
}

/**
 * Roll a Deployment back to one of its own revisions by restoring that ReplicaSet's pod template.
 * The cluster then rolls forward to it as it would to any other change, which is why the result is
 * a new revision rather than the old number returning. A revision whose template already matches
 * the live one is reported as skipped: there is nothing to undo, and writing would churn the pods
 * for no change.
 */
export function rollbackDeployment(input: RollbackInput): Promise<RollbackResult> {
    const op = 'deployments.rollback';
    return withK8s(op, async () => {
        assertContext(input.context, op);
        const d = await readDeploymentForWrite(input.name, input.namespace, op);
        const target = ownedReplicaSets(d, await replicaSetsOf(d)).find((rs) => revisionOf(rs) === input.revision);
        if (!target) {
            throw new K8sError(
                'notFound',
                `Deployment "${input.name}" has no revision ${input.revision} to roll back to.`,
                op,
            );
        }
        const result = {
            kind: 'Deployment',
            name: input.name,
            namespace: input.namespace,
            revision: input.revision,
        };
        if (sameTemplate(d.spec, target.spec)) return { ...result, skipped: true };
        await apis().apps.patchNamespacedDeployment({
            name: input.name,
            namespace: input.namespace,
            body: rollbackPatch(d, target),
        });
        return { ...result, skipped: false };
    });
}

/**
 * Hold a rollout where it stands, or let it continue. A paused Deployment keeps serving the pods it
 * has and applies no further change, which is what makes it safe to edit a manifest mid-rollout.
 */
export function setDeploymentPaused(input: PauseInput): Promise<WriteResult> {
    const op = 'deployments.pause';
    return withK8s(op, async () => {
        assertContext(input.context, op);
        await readDeploymentForWrite(input.name, input.namespace, op);
        const patch: PausePatch = {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: input.name, namespace: input.namespace },
            spec: { paused: input.paused },
        };
        await apis().objects.patch(patch);
        return { kind: 'Deployment', name: input.name, namespace: input.namespace };
    });
}

export function listReplicaSets(namespace?: string): Promise<ReplicaSetRow[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().apps.listNamespacedReplicaSet({ namespace: ns }),
            () => apis().apps.listReplicaSetForAllNamespaces(),
        );
        return items.map((rs) => toReplicaSetRow(rs));
    });
}

export function getReplicaSet(name: string, namespace?: string): Promise<ReplicaSetDetail | null> {
    return withK8s('resources.get', async () => {
        const rs = await getNamespaced(name, namespace, (n, ns) =>
            apis().apps.readNamespacedReplicaSet({ name: n, namespace: ns }),
        );
        return rs ? toReplicaSetDetail(rs) : null;
    });
}

export function listReplicationControllers(namespace?: string): Promise<ReplicaSetRow[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().core.listNamespacedReplicationController({ namespace: ns }),
            () => apis().core.listReplicationControllerForAllNamespaces(),
        );
        return items.map((rc) => toReplicationController(rc));
    });
}

export function getReplicationController(name: string, namespace?: string): Promise<ReplicaSetDetail | null> {
    return withK8s('resources.get', async () => {
        const rc = await getNamespaced(name, namespace, (n, ns) =>
            apis().core.readNamespacedReplicationController({ name: n, namespace: ns }),
        );
        return rc ? toReplicationControllerDetail(rc) : null;
    });
}

export function listStatefulSets(namespace?: string): Promise<StatefulSet[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().apps.listNamespacedStatefulSet({ namespace: ns }),
            () => apis().apps.listStatefulSetForAllNamespaces(),
        );
        return items.map((s) => toStatefulSet(s));
    });
}

export function getStatefulSet(name: string, namespace?: string): Promise<StatefulSetDetail | null> {
    return withK8s('resources.get', async () => {
        const s = await getNamespaced(name, namespace, (n, ns) =>
            apis().apps.readNamespacedStatefulSet({ name: n, namespace: ns }),
        );
        return s ? toStatefulSetDetail(s) : null;
    });
}

export function listDaemonSets(namespace?: string): Promise<DaemonSet[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().apps.listNamespacedDaemonSet({ namespace: ns }),
            () => apis().apps.listDaemonSetForAllNamespaces(),
        );
        return items.map((d) => toDaemonSet(d));
    });
}

export function getDaemonSet(name: string, namespace?: string): Promise<DaemonSetDetail | null> {
    return withK8s('resources.get', async () => {
        const d = await getNamespaced(name, namespace, (n, ns) =>
            apis().apps.readNamespacedDaemonSet({ name: n, namespace: ns }),
        );
        return d ? toDaemonSetDetail(d) : null;
    });
}

/**
 * Terminal conditions decide the status; a failure outranks a completion. A job that has not
 * finished is Suspended when its spec or its condition says so, since it runs no pods then, and
 * Running otherwise.
 */
export function jobStatus(job: V1Job): JobStatus {
    const conditions = job.status?.conditions ?? [];
    if (conditions.some((c) => c.type === 'Failed' && c.status === 'True')) return 'Failed';
    if (conditions.some((c) => c.type === 'Complete' && c.status === 'True')) return 'Complete';
    if (job.spec?.suspend || conditions.some((c) => c.type === 'Suspended' && c.status === 'True')) return 'Suspended';
    return 'Running';
}

export function toJob(job: V1Job, now = Date.now()): Job {
    return {
        name: job.metadata?.name ?? '',
        namespace: job.metadata?.namespace ?? '',
        completions: readyRatio(job.status?.succeeded, job.spec?.completions ?? 1),
        duration: duration(job.status?.startTime, job.status?.completionTime ?? new Date(now)),
        status: jobStatus(job),
        age: age(job.metadata?.creationTimestamp, now),
    };
}

export function toJobDetail(job: V1Job, now = Date.now()): JobDetail {
    return {
        ...toJob(job, now),
        labels: toPairs(job.metadata?.labels),
        annotations: toPairs(job.metadata?.annotations),
    };
}

export function toCronJob(cronJob: V1CronJob, now = Date.now()): CronJob {
    return {
        name: cronJob.metadata?.name ?? '',
        namespace: cronJob.metadata?.namespace ?? '',
        schedule: dash(cronJob.spec?.schedule),
        suspend: cronJob.spec?.suspend ?? false,
        active: cronJob.status?.active?.length ?? 0,
        lastSchedule: ago(cronJob.status?.lastScheduleTime, now),
        age: age(cronJob.metadata?.creationTimestamp, now),
    };
}

export function toCronJobDetail(cronJob: V1CronJob, now = Date.now()): CronJobDetail {
    return {
        ...toCronJob(cronJob, now),
        labels: toPairs(cronJob.metadata?.labels),
        annotations: toPairs(cronJob.metadata?.annotations),
    };
}

/** Current over target utilisation of the first resource metric; an em-dash when neither side reports. */
export function hpaTargets(autoscaler: V2HorizontalPodAutoscaler): string {
    const current = autoscaler.status?.currentMetrics?.[0]?.resource?.current?.averageUtilization;
    const target = autoscaler.spec?.metrics?.[0]?.resource?.target?.averageUtilization;
    if (current == null && target == null) return '—';
    return `${current ?? 0}% / ${target ?? 0}%`;
}

/** The CPU utilisation an autoscaler aims for, when CPU is among the metrics it watches at all. */
export function cpuUtilisationTarget(autoscaler: V2HorizontalPodAutoscaler): number | null {
    const cpu = (autoscaler.spec?.metrics ?? []).find(
        (metric) => metric.type === 'Resource' && metric.resource?.name === 'cpu',
    );
    return cpu?.resource?.target?.averageUtilization ?? null;
}

export function toAutoscaler(autoscaler: V2HorizontalPodAutoscaler, now = Date.now()): Autoscaler {
    const ref = autoscaler.spec?.scaleTargetRef;
    return {
        name: autoscaler.metadata?.name ?? '',
        namespace: autoscaler.metadata?.namespace ?? '',
        reference: ref ? `${ref.kind}/${ref.name}` : '—',
        min: autoscaler.spec?.minReplicas ?? 1,
        max: autoscaler.spec?.maxReplicas ?? 0,
        replicas: autoscaler.status?.currentReplicas ?? 0,
        targets: hpaTargets(autoscaler),
        targetCpuPercent: cpuUtilisationTarget(autoscaler),
        age: age(autoscaler.metadata?.creationTimestamp, now),
    };
}

export function toAutoscalerDetail(autoscaler: V2HorizontalPodAutoscaler, now = Date.now()): AutoscalerDetail {
    return {
        ...toAutoscaler(autoscaler, now),
        labels: toPairs(autoscaler.metadata?.labels),
        annotations: toPairs(autoscaler.metadata?.annotations),
    };
}

export function listJobs(namespace?: string): Promise<Job[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().batch.listNamespacedJob({ namespace: ns }),
            () => apis().batch.listJobForAllNamespaces(),
        );
        return items.map((job) => toJob(job));
    });
}

export function getJob(name: string, namespace?: string): Promise<JobDetail | null> {
    return withK8s('resources.get', async () => {
        const job = await getNamespaced(name, namespace, (n, ns) =>
            apis().batch.readNamespacedJob({ name: n, namespace: ns }),
        );
        return job ? toJobDetail(job) : null;
    });
}

export function listCronJobs(namespace?: string): Promise<CronJob[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().batch.listNamespacedCronJob({ namespace: ns }),
            () => apis().batch.listCronJobForAllNamespaces(),
        );
        return items.map((cronJob) => toCronJob(cronJob));
    });
}

export function getCronJob(name: string, namespace?: string): Promise<CronJobDetail | null> {
    return withK8s('resources.get', async () => {
        const cronJob = await getNamespaced(name, namespace, (n, ns) =>
            apis().batch.readNamespacedCronJob({ name: n, namespace: ns }),
        );
        return cronJob ? toCronJobDetail(cronJob) : null;
    });
}

export function listAutoscalers(namespace?: string): Promise<Autoscaler[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().hpa.listNamespacedHorizontalPodAutoscaler({ namespace: ns }),
            () => apis().hpa.listHorizontalPodAutoscalerForAllNamespaces(),
        );
        return items.map((autoscaler) => toAutoscaler(autoscaler));
    });
}

export function getAutoscaler(name: string, namespace?: string): Promise<AutoscalerDetail | null> {
    return withK8s('resources.get', async () => {
        const autoscaler = await getNamespaced(name, namespace, (n, ns) =>
            apis().hpa.readNamespacedHorizontalPodAutoscaler({ name: n, namespace: ns }),
        );
        return autoscaler ? toAutoscalerDetail(autoscaler) : null;
    });
}
