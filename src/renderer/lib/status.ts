import type { ReleaseObjectState, ReleaseStatus, ReleaseStatusKind } from '../../shared/k8s/addons';
import type { ReleaseHealth } from './release-health';
import type { ClusterStatus, NodeStatus } from '../../shared/k8s/status';
import type { NamespaceTone } from '../../shared/k8s/cluster';
import type { EndpointReady, NetworkStatus } from '../../shared/k8s/network';
import type { ClaimStatus, SnapshotReady, VolumeStatus } from '../../shared/k8s/storage';
import type { ContainerState, PodStatus } from '../../shared/k8s/pods';
import type { DisruptionStatus } from '../../shared/k8s/policy';
import type { WebhookStatus } from '../../shared/k8s/admission';
import type { ApiServiceStatus } from '../../shared/k8s/apiserver';
import type { DeploymentStatus, JobStatus, RolloutState } from '../../shared/k8s/workloads';

/** Presentational tone a status badge renders with. */
export type StatusTone = 'ok' | 'warn' | 'danger' | 'neutral' | 'accent';

export const CLUSTER_TONE: Record<ClusterStatus, StatusTone> = { Healthy: 'ok', Degraded: 'warn' };
export const NODE_TONE: Record<NodeStatus, StatusTone> = { Ready: 'ok', NotReady: 'danger', Cordoned: 'warn' };
export const NAMESPACE_TONE: Record<NamespaceTone, StatusTone> = { accent: 'accent', ok: 'ok', warn: 'warn' };
export const POD_TONE: Record<PodStatus, StatusTone> = {
    Running: 'ok',
    Succeeded: 'ok',
    Pending: 'warn',
    Terminating: 'neutral',
    Unknown: 'neutral',
    CrashLoop: 'danger',
    Error: 'danger',
    Failed: 'danger',
};
export const CONTAINER_TONE: Record<ContainerState, StatusTone> = {
    Running: 'ok',
    Completed: 'ok',
    Pending: 'warn',
    Unknown: 'neutral',
    CrashLoop: 'danger',
    Failed: 'danger',
};
export const DEPLOYMENT_TONE: Record<DeploymentStatus, StatusTone> = {
    Healthy: 'ok',
    Available: 'ok',
    Progressing: 'warn',
    Paused: 'neutral',
};
export const ROLLOUT_TONE: Record<RolloutState, StatusTone> = { Current: 'ok', Superseded: 'neutral' };
export const NETWORK_TONE: Record<NetworkStatus, StatusTone> = { Active: 'ok', Pending: 'warn' };
export const ENDPOINT_TONE: Record<EndpointReady, StatusTone> = { Ready: 'ok', NotReady: 'warn' };
export const VOLUME_TONE: Record<VolumeStatus, StatusTone> = {
    Bound: 'ok',
    Available: 'accent',
    Released: 'neutral',
    Pending: 'warn',
    Failed: 'danger',
    Unknown: 'neutral',
};
export const CLAIM_TONE: Record<ClaimStatus, StatusTone> = {
    Bound: 'ok',
    Pending: 'warn',
    Lost: 'danger',
    Unknown: 'neutral',
};
export const SNAPSHOT_TONE: Record<SnapshotReady, StatusTone> = { Ready: 'ok', Pending: 'warn' };
export const RELEASE_TONE: Record<ReleaseStatus, StatusTone> = {
    Deployed: 'ok',
    Superseded: 'neutral',
    Failed: 'danger',
    Progressing: 'accent',
    Terminating: 'warn',
    Unknown: 'neutral',
};
/** A webhook that fails closed is a dependency of writing at all, which is worth flagging. */
export const WEBHOOK_TONE: Record<WebhookStatus, StatusTone> = { Blocking: 'warn', Permissive: 'neutral' };
export const API_SERVICE_TONE: Record<ApiServiceStatus, StatusTone> = { Available: 'ok', Unavailable: 'danger' };

/** A budget allowing no disruption blocks a drain, which is worth flagging rather than colouring ok. */
export const DISRUPTION_TONE: Record<DisruptionStatus, StatusTone> = { Satisfied: 'ok', Blocked: 'warn' };
export const JOB_TONE: Record<JobStatus, StatusTone> = { Complete: 'ok', Running: 'accent', Failed: 'danger' };

/** An object a release rendered and the cluster no longer holds is drift, which a release is broken by. */
export const RELEASE_OBJECT_TONE: Record<ReleaseObjectState, StatusTone> = {
    Present: 'ok',
    Missing: 'danger',
    Unknown: 'neutral',
};
export const RELEASE_HEALTH_TONE: Record<ReleaseHealth, StatusTone> = {
    Healthy: 'ok',
    Degraded: 'warn',
    Failing: 'danger',
    Unknown: 'neutral',
};

/**
 * The tone map each kind's own list colours its status with, so an object a release rendered reads
 * the same beside the release as on its own screen.
 */
export const KIND_STATUS_TONE: Record<ReleaseStatusKind, Record<string, StatusTone>> = {
    Pod: POD_TONE,
    Deployment: DEPLOYMENT_TONE,
    Job: JOB_TONE,
    PodDisruptionBudget: DISRUPTION_TONE,
    Service: NETWORK_TONE,
    Ingress: NETWORK_TONE,
    PersistentVolume: VOLUME_TONE,
    PersistentVolumeClaim: CLAIM_TONE,
    VolumeSnapshot: SNAPSHOT_TONE,
    MutatingWebhookConfiguration: WEBHOOK_TONE,
    ValidatingWebhookConfiguration: WEBHOOK_TONE,
    APIService: API_SERVICE_TONE,
};

/** Tone for a resource-usage percentage: ok below 75, warn from 75, danger above 90. */
export function usageTone(percent: number): Extract<StatusTone, 'ok' | 'warn' | 'danger'> {
    return percent > 90 ? 'danger' : percent > 75 ? 'warn' : 'ok';
}
