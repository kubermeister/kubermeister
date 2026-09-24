import { z } from 'zod';

/**
 * One entry per resource kind the app knows. Every kind-keyed map derives from this so adding a
 * kind is one edit here plus its transforms in `src/main/k8s/resources`.
 */
export interface KindInfo {
    /** Canonical Kind as it appears in manifests and API responses. */
    kind: string;
    apiVersion: string;
    /** True for kinds that live outside any namespace. */
    clusterScoped: boolean;
    /** True for kinds exposing a `/scale` subresource the app drives. */
    scalable: boolean;
    /** The list screen for this kind (hash-route path). */
    listPath: string;
}

export const KIND_REGISTRY = {
    Pod: { kind: 'Pod', apiVersion: 'v1', clusterScoped: false, scalable: false, listPath: '/workloads/pods' },
    Deployment: {
        kind: 'Deployment',
        apiVersion: 'apps/v1',
        clusterScoped: false,
        scalable: true,
        listPath: '/workloads/deployments',
    },
    StatefulSet: {
        kind: 'StatefulSet',
        apiVersion: 'apps/v1',
        clusterScoped: false,
        scalable: true,
        listPath: '/workloads/statefulsets',
    },
    DaemonSet: {
        kind: 'DaemonSet',
        apiVersion: 'apps/v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/workloads/daemonsets',
    },
    ReplicaSet: {
        kind: 'ReplicaSet',
        apiVersion: 'apps/v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/workloads/replicasets',
    },
    ReplicationController: {
        kind: 'ReplicationController',
        apiVersion: 'v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/workloads/replicationcontrollers',
    },
    Job: { kind: 'Job', apiVersion: 'batch/v1', clusterScoped: false, scalable: false, listPath: '/workloads/jobs' },
    CronJob: {
        kind: 'CronJob',
        apiVersion: 'batch/v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/workloads/cronjobs',
    },
    HorizontalPodAutoscaler: {
        kind: 'HorizontalPodAutoscaler',
        apiVersion: 'autoscaling/v2',
        clusterScoped: false,
        scalable: false,
        listPath: '/workloads/autoscalers',
    },
    PodDisruptionBudget: {
        kind: 'PodDisruptionBudget',
        apiVersion: 'policy/v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/workloads/disruptionbudgets',
    },
    PriorityClass: {
        kind: 'PriorityClass',
        apiVersion: 'scheduling.k8s.io/v1',
        clusterScoped: true,
        scalable: false,
        listPath: '/overview/priorityclasses',
    },
    Lease: {
        kind: 'Lease',
        apiVersion: 'coordination.k8s.io/v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/overview/leases',
    },
    RuntimeClass: {
        kind: 'RuntimeClass',
        apiVersion: 'node.k8s.io/v1',
        clusterScoped: true,
        scalable: false,
        listPath: '/overview/runtimeclasses',
    },
    ConfigMap: {
        kind: 'ConfigMap',
        apiVersion: 'v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/workloads/configmaps',
    },
    Secret: { kind: 'Secret', apiVersion: 'v1', clusterScoped: false, scalable: false, listPath: '/workloads/secrets' },
    Service: {
        kind: 'Service',
        apiVersion: 'v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/network/services',
    },
    Ingress: {
        kind: 'Ingress',
        apiVersion: 'networking.k8s.io/v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/network/ingresses',
    },
    Endpoints: {
        kind: 'Endpoints',
        apiVersion: 'v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/network/endpoints',
    },
    NetworkPolicy: {
        kind: 'NetworkPolicy',
        apiVersion: 'networking.k8s.io/v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/network/networkpolicies',
    },
    IngressClass: {
        kind: 'IngressClass',
        apiVersion: 'networking.k8s.io/v1',
        clusterScoped: true,
        scalable: false,
        listPath: '/network/ingressclasses',
    },
    PersistentVolume: {
        kind: 'PersistentVolume',
        apiVersion: 'v1',
        clusterScoped: true,
        scalable: false,
        listPath: '/storage/volumes',
    },
    PersistentVolumeClaim: {
        kind: 'PersistentVolumeClaim',
        apiVersion: 'v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/storage/claims',
    },
    StorageClass: {
        kind: 'StorageClass',
        apiVersion: 'storage.k8s.io/v1',
        clusterScoped: true,
        scalable: false,
        listPath: '/storage/storageclasses',
    },
    VolumeSnapshot: {
        kind: 'VolumeSnapshot',
        apiVersion: 'snapshot.storage.k8s.io/v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/storage/snapshots',
    },
    CSIDriver: {
        kind: 'CSIDriver',
        apiVersion: 'storage.k8s.io/v1',
        clusterScoped: true,
        scalable: false,
        listPath: '/storage/csidrivers',
    },
    CSINode: {
        kind: 'CSINode',
        apiVersion: 'storage.k8s.io/v1',
        clusterScoped: true,
        scalable: false,
        listPath: '/storage/csinodes',
    },
    CSIStorageCapacity: {
        kind: 'CSIStorageCapacity',
        apiVersion: 'storage.k8s.io/v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/storage/capacity',
    },
    ServiceAccount: {
        kind: 'ServiceAccount',
        apiVersion: 'v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/access/serviceaccounts',
    },
    Role: {
        kind: 'Role',
        apiVersion: 'rbac.authorization.k8s.io/v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/access/roles',
    },
    RoleBinding: {
        kind: 'RoleBinding',
        apiVersion: 'rbac.authorization.k8s.io/v1',
        clusterScoped: false,
        scalable: false,
        listPath: '/access/rolebindings',
    },
    ClusterRole: {
        kind: 'ClusterRole',
        apiVersion: 'rbac.authorization.k8s.io/v1',
        clusterScoped: true,
        scalable: false,
        listPath: '/access/clusterroles',
    },
    ClusterRoleBinding: {
        kind: 'ClusterRoleBinding',
        apiVersion: 'rbac.authorization.k8s.io/v1',
        clusterScoped: true,
        scalable: false,
        listPath: '/access/clusterrolebindings',
    },
    MutatingWebhookConfiguration: {
        kind: 'MutatingWebhookConfiguration',
        apiVersion: 'admissionregistration.k8s.io/v1',
        clusterScoped: true,
        scalable: false,
        listPath: '/addons/mutatingwebhooks',
    },
    ValidatingWebhookConfiguration: {
        kind: 'ValidatingWebhookConfiguration',
        apiVersion: 'admissionregistration.k8s.io/v1',
        clusterScoped: true,
        scalable: false,
        listPath: '/addons/validatingwebhooks',
    },
    ValidatingAdmissionPolicy: {
        kind: 'ValidatingAdmissionPolicy',
        apiVersion: 'admissionregistration.k8s.io/v1',
        clusterScoped: true,
        scalable: false,
        listPath: '/addons/admissionpolicies',
    },
    APIService: {
        kind: 'APIService',
        apiVersion: 'apiregistration.k8s.io/v1',
        clusterScoped: true,
        scalable: false,
        listPath: '/addons/apiservices',
    },
    FlowSchema: {
        kind: 'FlowSchema',
        apiVersion: 'flowcontrol.apiserver.k8s.io/v1',
        clusterScoped: true,
        scalable: false,
        listPath: '/addons/flowschemas',
    },
    CustomResourceDefinition: {
        kind: 'CustomResourceDefinition',
        apiVersion: 'apiextensions.k8s.io/v1',
        clusterScoped: true,
        scalable: false,
        listPath: '/addons/crds',
    },
} as const satisfies Record<string, KindInfo>;

export type Kind = keyof typeof KIND_REGISTRY;

export const KINDS = Object.keys(KIND_REGISTRY) as [Kind, ...Kind[]];
export const kindSchema = z.enum(KINDS);

export function kindInfo(kind: Kind): KindInfo {
    return KIND_REGISTRY[kind];
}

/**
 * Kinds carrying a pod template whose controller rolls its pods when the template changes. A
 * restart is a fresh stamp on that template, so a kind without one cannot be restarted at all.
 */
export const RESTARTABLE_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet'] as const satisfies readonly Kind[];
export const restartKindSchema = z.enum(RESTARTABLE_KINDS);
export type RestartKind = (typeof RESTARTABLE_KINDS)[number];

/**
 * Cluster-scoped kinds the app does not model but still meets: nodes have bespoke channels, the
 * rest may arrive in a manifest a user applies from the editor. The one list every scope decision
 * (namespace stamping, event lookup) consults, so two call sites can never disagree about a kind.
 */
export const CLUSTER_SCOPED_EXTRA_KINDS: readonly string[] = [
    'Namespace',
    'Node',
    'VolumeAttachment',
    'VolumeSnapshotClass',
];

const CLUSTER_SCOPED_KIND_NAMES: ReadonlySet<string> = new Set([
    ...KINDS.filter((kind) => KIND_REGISTRY[kind].clusterScoped).map((kind) => KIND_REGISTRY[kind].kind),
    ...CLUSTER_SCOPED_EXTRA_KINDS,
]);

/** Whether a manifest `kind` is known to live outside any namespace. Unknown kinds answer false. */
export function isClusterScopedKindName(kind: string): boolean {
    return CLUSTER_SCOPED_KIND_NAMES.has(kind);
}

/** Whether a manifest `kind` names a kind the app knows at all, registered or in the extras list. */
export function isKnownKindName(kind: string): boolean {
    return CLUSTER_SCOPED_KIND_NAMES.has(kind) || KINDS.some((k) => KIND_REGISTRY[k].kind === kind);
}

/** The API group of an `apiVersion`: `apps` for `apps/v1`, the empty core group for `v1`. */
export function apiGroupOf(apiVersion: string): string {
    const slash = apiVersion.indexOf('/');
    return slash === -1 ? '' : apiVersion.slice(0, slash);
}

/**
 * The registered kind a manifest's `apiVersion` and `kind` name, matched on the API group as well
 * as the kind: a custom resource may well call itself `Service` (Knative's does), and reading it as
 * the core one would colour it with a status it does not have and link it to a screen it is not on.
 * Any version of the group matches, since the registry records one version and a chart may render
 * another the server still serves.
 */
export function registeredKindOf(apiVersion: string, kind: string): Kind | undefined {
    const group = apiGroupOf(apiVersion);
    return KINDS.find(
        (candidate) =>
            KIND_REGISTRY[candidate].kind === kind && apiGroupOf(KIND_REGISTRY[candidate].apiVersion) === group,
    );
}
