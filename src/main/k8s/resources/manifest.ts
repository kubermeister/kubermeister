import type { V1ObjectMeta } from '@kubernetes/client-node';
import { isClusterScopedManifestKind, type Manifest, type ManifestKind } from '../../../shared/k8s/manifest.js';
import { KIND_REGISTRY } from '../../../shared/k8s/registry.js';
import { apis, resolveObjectNamespace } from '../client.js';
import { K8sError, withK8s } from '../errors.js';
import { yamlToText } from '../yaml.js';
import { listSnapshotObjects } from './storage.js';

/**
 * Reading one live object as raw YAML. The list call cannot live in the shared registry (it closes
 * over the client), so it is the one per-kind fact kept here; everything else about a kind comes
 * from {@link KIND_REGISTRY}. Typing the map over every kind makes a new kind a compile error until
 * its manifest is readable too.
 */

interface RawItem {
    metadata?: V1ObjectMeta;
}

/**
 * Lists the raw objects of one kind in one namespace. A namespaced kind is only ever listed in a
 * concrete namespace (see {@link findRawObject}); a cluster-scoped kind ignores the argument.
 */
type ListFn = (namespace: string) => Promise<{ items: RawItem[] }>;

const LIST_FNS: Record<ManifestKind, ListFn> = {
    Pod: (ns) => apis().core.listNamespacedPod({ namespace: ns }),
    Deployment: (ns) => apis().apps.listNamespacedDeployment({ namespace: ns }),
    StatefulSet: (ns) => apis().apps.listNamespacedStatefulSet({ namespace: ns }),
    DaemonSet: (ns) => apis().apps.listNamespacedDaemonSet({ namespace: ns }),
    ReplicaSet: (ns) => apis().apps.listNamespacedReplicaSet({ namespace: ns }),
    ReplicationController: (ns) => apis().core.listNamespacedReplicationController({ namespace: ns }),
    Job: (ns) => apis().batch.listNamespacedJob({ namespace: ns }),
    CronJob: (ns) => apis().batch.listNamespacedCronJob({ namespace: ns }),
    HorizontalPodAutoscaler: (ns) => apis().hpa.listNamespacedHorizontalPodAutoscaler({ namespace: ns }),
    PodDisruptionBudget: (ns) => apis().policy.listNamespacedPodDisruptionBudget({ namespace: ns }),
    PriorityClass: () => apis().scheduling.listPriorityClass(),
    Lease: (ns) => apis().coordination.listNamespacedLease({ namespace: ns }),
    RuntimeClass: () => apis().runtime.listRuntimeClass(),
    ConfigMap: (ns) => apis().core.listNamespacedConfigMap({ namespace: ns }),
    Secret: (ns) => apis().core.listNamespacedSecret({ namespace: ns }),
    Service: (ns) => apis().core.listNamespacedService({ namespace: ns }),
    Ingress: (ns) => apis().net.listNamespacedIngress({ namespace: ns }),
    Endpoints: (ns) => apis().core.listNamespacedEndpoints({ namespace: ns }),
    NetworkPolicy: (ns) => apis().net.listNamespacedNetworkPolicy({ namespace: ns }),
    IngressClass: () => apis().net.listIngressClass(),
    PersistentVolume: () => apis().core.listPersistentVolume(),
    PersistentVolumeClaim: (ns) => apis().core.listNamespacedPersistentVolumeClaim({ namespace: ns }),
    StorageClass: () => apis().storage.listStorageClass(),
    // The snapshot reader returns the objects directly, since its CRD may be absent entirely.
    VolumeSnapshot: async (ns) => ({ items: await listSnapshotObjects(ns) }),
    CSIDriver: () => apis().storage.listCSIDriver(),
    CSINode: () => apis().storage.listCSINode(),
    CSIStorageCapacity: (ns) => apis().storage.listNamespacedCSIStorageCapacity({ namespace: ns }),
    ServiceAccount: (ns) => apis().core.listNamespacedServiceAccount({ namespace: ns }),
    Role: (ns) => apis().rbac.listNamespacedRole({ namespace: ns }),
    RoleBinding: (ns) => apis().rbac.listNamespacedRoleBinding({ namespace: ns }),
    ClusterRole: () => apis().rbac.listClusterRole(),
    ClusterRoleBinding: () => apis().rbac.listClusterRoleBinding(),
    MutatingWebhookConfiguration: () => apis().admission.listMutatingWebhookConfiguration(),
    ValidatingWebhookConfiguration: () => apis().admission.listValidatingWebhookConfiguration(),
    ValidatingAdmissionPolicy: () => apis().admission.listValidatingAdmissionPolicy(),
    APIService: () => apis().apiregistration.listAPIService(),
    FlowSchema: () => apis().flowcontrol.listFlowSchema(),
    CustomResourceDefinition: () => apis().apiextensions.listCustomResourceDefinition(),
    Node: () => apis().core.listNode(),
    Namespace: () => apis().core.listNamespace(),
};

/** Neither a node nor a namespace is a registered kind, so their type meta is stated here. */
const NODE_FACTS = { apiVersion: 'v1', kind: 'Node' };
const NAMESPACE_FACTS = { apiVersion: 'v1', kind: 'Namespace' };

/** The type meta a listed object omits, which every document the app writes has to carry. */
export function typeMeta(kind: ManifestKind): { apiVersion: string; kind: string } {
    if (kind === 'Node') return NODE_FACTS;
    if (kind === 'Namespace') return NAMESPACE_FACTS;
    const info = KIND_REGISTRY[kind];
    return { apiVersion: info.apiVersion, kind: info.kind };
}

/**
 * The one object of a kind with this name in one namespace. A namespaced kind is only ever looked
 * up in a concrete namespace, the explicit or the active one: with neither, the lookup is refused
 * rather than settled by whichever same-named object across the cluster lists first, because what
 * comes back here is what the editor writes back later.
 */
export type { RawItem };

export async function findRawObject(
    kind: ManifestKind,
    name: string,
    namespace: string | undefined,
    op: string,
): Promise<RawItem | undefined> {
    const clusterScoped = isClusterScopedManifestKind(kind);
    const ns = clusterScoped ? undefined : (resolveObjectNamespace(namespace) ?? undefined);
    if (!clusterScoped && !ns) {
        throw new K8sError('invalid', `A namespace is required to read ${typeMeta(kind).kind} "${name}".`, op);
    }
    return (await listRawObjects(kind, ns)).find((item) => item.metadata?.name === name);
}

/**
 * Every object of one kind in one namespace, or cluster-wide for a cluster-scoped kind. The caller
 * has already resolved the namespace; nothing here falls back to the active one.
 */
export async function listRawObjects(kind: ManifestKind, namespace: string | undefined): Promise<RawItem[]> {
    // A cluster-scoped list takes no namespace; the empty string only satisfies the shared signature.
    const { items } = await LIST_FNS[kind](namespace ?? '');
    return items;
}

/**
 * One object's live manifest. A missing object is a real error rather than empty text, because the
 * panel needs to say so instead of showing a blank editor.
 */
export function getObjectYaml(kind: ManifestKind, name: string, namespace?: string): Promise<Manifest> {
    const op = 'resources.getYaml';
    return withK8s(op, async () => {
        const obj = await findRawObject(kind, name, namespace, op);
        const meta = typeMeta(kind);
        if (!obj) throw new K8sError('notFound', `${meta.kind} "${name}" was not found.`, op);
        const manifest: Record<string, unknown> = { ...obj };
        manifest.apiVersion ??= meta.apiVersion;
        manifest.kind ??= meta.kind;
        return { yaml: yamlToText(manifest), kind: meta.kind, namespace: obj.metadata?.namespace };
    });
}
