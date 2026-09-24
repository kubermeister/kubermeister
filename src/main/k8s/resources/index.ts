import type { Kind } from '../../../shared/k8s/registry.js';
import type {
    DetailOf,
    ResourceGetInput,
    ResourceGetOutput,
    ResourceListInput,
    ResourceListOutput,
    RowOf,
} from '../../../shared/k8s/resources.js';
import { getConfigMap, getSecret, listConfigMaps, listSecrets } from './config.js';
import {
    getEndpoints,
    getIngress,
    getNetworkPolicy,
    getService,
    listEndpoints,
    listIngresses,
    listNetworkPolicies,
    listServices,
} from './network.js';
import { getCustomResource, listCustomResources } from './crds.js';
import {
    getAdmissionPolicy,
    getMutatingWebhook,
    getValidatingWebhook,
    listAdmissionPolicies,
    listMutatingWebhooks,
    listValidatingWebhooks,
} from './admission.js';
import { getApiService, getFlowSchema, listApiServices, listFlowSchemas } from './apiserver.js';
import { getIngressClass, getRuntimeClass, listIngressClasses, listRuntimeClasses } from './classes.js';
import { getCsiCapacity, getCsiDriver, getCsiNode, listCsiCapacities, listCsiDrivers, listCsiNodes } from './csi.js';
import {
    getClusterRole,
    getClusterRoleBinding,
    getRole,
    getRoleBinding,
    getServiceAccount,
    listClusterRoleBindings,
    listClusterRoles,
    listRoleBindings,
    listRoles,
    listServiceAccounts,
} from './access.js';
import { getPod, listPods } from './pods.js';
import {
    getLease,
    getPodDisruptionBudget,
    getPriorityClass,
    listLeases,
    listPodDisruptionBudgets,
    listPriorityClasses,
} from './policy.js';
import {
    getClaim,
    getSnapshot,
    getStorageClass,
    getVolume,
    listClaims,
    listSnapshots,
    listStorageClasses,
    listVolumes,
} from './storage.js';
import {
    getAutoscaler,
    getCronJob,
    getDaemonSet,
    getDeployment,
    getJob,
    getReplicaSet,
    getReplicationController,
    getStatefulSet,
    listAutoscalers,
    listCronJobs,
    listDaemonSets,
    listDeployments,
    listJobs,
    listReplicaSets,
    listReplicationControllers,
    listStatefulSets,
} from './workloads.js';

/** Per-kind fetchers behind the generic channels. Adding a kind means one entry here. */
interface Source<K extends Kind> {
    list: (namespace?: string) => Promise<Array<RowOf<K>>>;
    get: (name: string, namespace?: string) => Promise<DetailOf<K> | null>;
}

const SOURCES: { [K in Kind]: Source<K> } = {
    Pod: { list: listPods, get: getPod },
    Deployment: { list: listDeployments, get: getDeployment },
    StatefulSet: { list: listStatefulSets, get: getStatefulSet },
    DaemonSet: { list: listDaemonSets, get: getDaemonSet },
    ReplicaSet: { list: listReplicaSets, get: getReplicaSet },
    ReplicationController: { list: listReplicationControllers, get: getReplicationController },
    Job: { list: listJobs, get: getJob },
    CronJob: { list: listCronJobs, get: getCronJob },
    HorizontalPodAutoscaler: { list: listAutoscalers, get: getAutoscaler },
    PodDisruptionBudget: { list: listPodDisruptionBudgets, get: getPodDisruptionBudget },
    PriorityClass: { list: () => listPriorityClasses(), get: (name) => getPriorityClass(name) },
    Lease: { list: listLeases, get: getLease },
    RuntimeClass: { list: () => listRuntimeClasses(), get: (name) => getRuntimeClass(name) },
    ConfigMap: { list: listConfigMaps, get: getConfigMap },
    Secret: { list: listSecrets, get: getSecret },
    Service: { list: listServices, get: getService },
    Ingress: { list: listIngresses, get: getIngress },
    Endpoints: { list: listEndpoints, get: getEndpoints },
    NetworkPolicy: { list: listNetworkPolicies, get: getNetworkPolicy },
    IngressClass: { list: () => listIngressClasses(), get: (name) => getIngressClass(name) },
    PersistentVolume: { list: () => listVolumes(), get: (name) => getVolume(name) },
    PersistentVolumeClaim: { list: listClaims, get: getClaim },
    StorageClass: { list: () => listStorageClasses(), get: (name) => getStorageClass(name) },
    VolumeSnapshot: { list: listSnapshots, get: getSnapshot },
    CSIDriver: { list: () => listCsiDrivers(), get: (name) => getCsiDriver(name) },
    CSINode: { list: () => listCsiNodes(), get: (name) => getCsiNode(name) },
    CSIStorageCapacity: { list: listCsiCapacities, get: getCsiCapacity },
    ServiceAccount: { list: listServiceAccounts, get: getServiceAccount },
    Role: { list: listRoles, get: getRole },
    RoleBinding: { list: listRoleBindings, get: getRoleBinding },
    ClusterRole: { list: () => listClusterRoles(), get: (name) => getClusterRole(name) },
    ClusterRoleBinding: { list: () => listClusterRoleBindings(), get: (name) => getClusterRoleBinding(name) },
    MutatingWebhookConfiguration: { list: () => listMutatingWebhooks(), get: (name) => getMutatingWebhook(name) },
    ValidatingWebhookConfiguration: { list: () => listValidatingWebhooks(), get: (name) => getValidatingWebhook(name) },
    ValidatingAdmissionPolicy: { list: () => listAdmissionPolicies(), get: (name) => getAdmissionPolicy(name) },
    APIService: { list: () => listApiServices(), get: (name) => getApiService(name) },
    FlowSchema: { list: () => listFlowSchemas(), get: (name) => getFlowSchema(name) },
    CustomResourceDefinition: { list: () => listCustomResources(), get: (name) => getCustomResource(name) },
};

/** One kind's rows through that kind's own list transform, for a caller that already knows the kind. */
export function listRowsOf<K extends Kind>(kind: K, namespace?: string): Promise<Array<RowOf<K>>> {
    return SOURCES[kind].list(namespace);
}

export async function listResources(input: ResourceListInput): Promise<ResourceListOutput> {
    switch (input.kind) {
        case 'Pod':
            return { kind: 'Pod', items: await SOURCES.Pod.list(input.namespace) };
        case 'Deployment':
            return { kind: 'Deployment', items: await SOURCES.Deployment.list(input.namespace) };
        case 'StatefulSet':
            return { kind: 'StatefulSet', items: await SOURCES.StatefulSet.list(input.namespace) };
        case 'DaemonSet':
            return { kind: 'DaemonSet', items: await SOURCES.DaemonSet.list(input.namespace) };
        case 'ReplicaSet':
            return { kind: 'ReplicaSet', items: await SOURCES.ReplicaSet.list(input.namespace) };
        case 'ReplicationController':
            return {
                kind: 'ReplicationController',
                items: await SOURCES.ReplicationController.list(input.namespace),
            };
        case 'Job':
            return { kind: 'Job', items: await SOURCES.Job.list(input.namespace) };
        case 'CronJob':
            return { kind: 'CronJob', items: await SOURCES.CronJob.list(input.namespace) };
        case 'HorizontalPodAutoscaler':
            return {
                kind: 'HorizontalPodAutoscaler',
                items: await SOURCES.HorizontalPodAutoscaler.list(input.namespace),
            };
        case 'PodDisruptionBudget':
            return { kind: 'PodDisruptionBudget', items: await SOURCES.PodDisruptionBudget.list(input.namespace) };
        case 'PriorityClass':
            return { kind: 'PriorityClass', items: await SOURCES.PriorityClass.list() };
        case 'Lease':
            return { kind: 'Lease', items: await SOURCES.Lease.list(input.namespace) };
        case 'RuntimeClass':
            return { kind: 'RuntimeClass', items: await SOURCES.RuntimeClass.list() };
        case 'ConfigMap':
            return { kind: 'ConfigMap', items: await SOURCES.ConfigMap.list(input.namespace) };
        case 'Secret':
            return { kind: 'Secret', items: await SOURCES.Secret.list(input.namespace) };
        case 'Service':
            return { kind: 'Service', items: await SOURCES.Service.list(input.namespace) };
        case 'Ingress':
            return { kind: 'Ingress', items: await SOURCES.Ingress.list(input.namespace) };
        case 'Endpoints':
            return { kind: 'Endpoints', items: await SOURCES.Endpoints.list(input.namespace) };
        case 'NetworkPolicy':
            return { kind: 'NetworkPolicy', items: await SOURCES.NetworkPolicy.list(input.namespace) };
        case 'IngressClass':
            return { kind: 'IngressClass', items: await SOURCES.IngressClass.list() };
        case 'PersistentVolume':
            return { kind: 'PersistentVolume', items: await SOURCES.PersistentVolume.list() };
        case 'PersistentVolumeClaim':
            return { kind: 'PersistentVolumeClaim', items: await SOURCES.PersistentVolumeClaim.list(input.namespace) };
        case 'StorageClass':
            return { kind: 'StorageClass', items: await SOURCES.StorageClass.list() };
        case 'VolumeSnapshot':
            return { kind: 'VolumeSnapshot', items: await SOURCES.VolumeSnapshot.list(input.namespace) };
        case 'CSIDriver':
            return { kind: 'CSIDriver', items: await SOURCES.CSIDriver.list() };
        case 'CSINode':
            return { kind: 'CSINode', items: await SOURCES.CSINode.list() };
        case 'CSIStorageCapacity':
            return { kind: 'CSIStorageCapacity', items: await SOURCES.CSIStorageCapacity.list(input.namespace) };
        case 'ServiceAccount':
            return { kind: 'ServiceAccount', items: await SOURCES.ServiceAccount.list(input.namespace) };
        case 'Role':
            return { kind: 'Role', items: await SOURCES.Role.list(input.namespace) };
        case 'RoleBinding':
            return { kind: 'RoleBinding', items: await SOURCES.RoleBinding.list(input.namespace) };
        case 'ClusterRole':
            return { kind: 'ClusterRole', items: await SOURCES.ClusterRole.list() };
        case 'ClusterRoleBinding':
            return { kind: 'ClusterRoleBinding', items: await SOURCES.ClusterRoleBinding.list() };
        case 'MutatingWebhookConfiguration':
            return {
                kind: 'MutatingWebhookConfiguration',
                items: await SOURCES.MutatingWebhookConfiguration.list(),
            };
        case 'ValidatingWebhookConfiguration':
            return {
                kind: 'ValidatingWebhookConfiguration',
                items: await SOURCES.ValidatingWebhookConfiguration.list(),
            };
        case 'ValidatingAdmissionPolicy':
            return { kind: 'ValidatingAdmissionPolicy', items: await SOURCES.ValidatingAdmissionPolicy.list() };
        case 'APIService':
            return { kind: 'APIService', items: await SOURCES.APIService.list() };
        case 'FlowSchema':
            return { kind: 'FlowSchema', items: await SOURCES.FlowSchema.list() };
        case 'CustomResourceDefinition':
            return { kind: 'CustomResourceDefinition', items: await SOURCES.CustomResourceDefinition.list() };
    }
}

export async function getResource(input: ResourceGetInput): Promise<ResourceGetOutput> {
    switch (input.kind) {
        case 'Pod':
            return { kind: 'Pod', item: await SOURCES.Pod.get(input.name, input.namespace) };
        case 'Deployment':
            return { kind: 'Deployment', item: await SOURCES.Deployment.get(input.name, input.namespace) };
        case 'StatefulSet':
            return { kind: 'StatefulSet', item: await SOURCES.StatefulSet.get(input.name, input.namespace) };
        case 'DaemonSet':
            return { kind: 'DaemonSet', item: await SOURCES.DaemonSet.get(input.name, input.namespace) };
        case 'ReplicaSet':
            return { kind: 'ReplicaSet', item: await SOURCES.ReplicaSet.get(input.name, input.namespace) };
        case 'ReplicationController':
            return {
                kind: 'ReplicationController',
                item: await SOURCES.ReplicationController.get(input.name, input.namespace),
            };
        case 'Job':
            return { kind: 'Job', item: await SOURCES.Job.get(input.name, input.namespace) };
        case 'CronJob':
            return { kind: 'CronJob', item: await SOURCES.CronJob.get(input.name, input.namespace) };
        case 'HorizontalPodAutoscaler':
            return {
                kind: 'HorizontalPodAutoscaler',
                item: await SOURCES.HorizontalPodAutoscaler.get(input.name, input.namespace),
            };
        case 'PodDisruptionBudget':
            return {
                kind: 'PodDisruptionBudget',
                item: await SOURCES.PodDisruptionBudget.get(input.name, input.namespace),
            };
        case 'PriorityClass':
            return { kind: 'PriorityClass', item: await SOURCES.PriorityClass.get(input.name) };
        case 'Lease':
            return { kind: 'Lease', item: await SOURCES.Lease.get(input.name, input.namespace) };
        case 'RuntimeClass':
            return { kind: 'RuntimeClass', item: await SOURCES.RuntimeClass.get(input.name) };
        case 'ConfigMap':
            return { kind: 'ConfigMap', item: await SOURCES.ConfigMap.get(input.name, input.namespace) };
        case 'Secret':
            return { kind: 'Secret', item: await SOURCES.Secret.get(input.name, input.namespace) };
        case 'Service':
            return { kind: 'Service', item: await SOURCES.Service.get(input.name, input.namespace) };
        case 'Ingress':
            return { kind: 'Ingress', item: await SOURCES.Ingress.get(input.name, input.namespace) };
        case 'Endpoints':
            return { kind: 'Endpoints', item: await SOURCES.Endpoints.get(input.name, input.namespace) };
        case 'NetworkPolicy':
            return { kind: 'NetworkPolicy', item: await SOURCES.NetworkPolicy.get(input.name, input.namespace) };
        case 'IngressClass':
            return { kind: 'IngressClass', item: await SOURCES.IngressClass.get(input.name) };
        case 'PersistentVolume':
            return { kind: 'PersistentVolume', item: await SOURCES.PersistentVolume.get(input.name) };
        case 'PersistentVolumeClaim':
            return {
                kind: 'PersistentVolumeClaim',
                item: await SOURCES.PersistentVolumeClaim.get(input.name, input.namespace),
            };
        case 'StorageClass':
            return { kind: 'StorageClass', item: await SOURCES.StorageClass.get(input.name) };
        case 'VolumeSnapshot':
            return { kind: 'VolumeSnapshot', item: await SOURCES.VolumeSnapshot.get(input.name, input.namespace) };
        case 'CSIDriver':
            return { kind: 'CSIDriver', item: await SOURCES.CSIDriver.get(input.name) };
        case 'CSINode':
            return { kind: 'CSINode', item: await SOURCES.CSINode.get(input.name) };
        case 'CSIStorageCapacity':
            return {
                kind: 'CSIStorageCapacity',
                item: await SOURCES.CSIStorageCapacity.get(input.name, input.namespace),
            };
        case 'ServiceAccount':
            return { kind: 'ServiceAccount', item: await SOURCES.ServiceAccount.get(input.name, input.namespace) };
        case 'Role':
            return { kind: 'Role', item: await SOURCES.Role.get(input.name, input.namespace) };
        case 'RoleBinding':
            return { kind: 'RoleBinding', item: await SOURCES.RoleBinding.get(input.name, input.namespace) };
        case 'ClusterRole':
            return { kind: 'ClusterRole', item: await SOURCES.ClusterRole.get(input.name) };
        case 'ClusterRoleBinding':
            return { kind: 'ClusterRoleBinding', item: await SOURCES.ClusterRoleBinding.get(input.name) };
        case 'MutatingWebhookConfiguration':
            return {
                kind: 'MutatingWebhookConfiguration',
                item: await SOURCES.MutatingWebhookConfiguration.get(input.name),
            };
        case 'ValidatingWebhookConfiguration':
            return {
                kind: 'ValidatingWebhookConfiguration',
                item: await SOURCES.ValidatingWebhookConfiguration.get(input.name),
            };
        case 'ValidatingAdmissionPolicy':
            return {
                kind: 'ValidatingAdmissionPolicy',
                item: await SOURCES.ValidatingAdmissionPolicy.get(input.name),
            };
        case 'APIService':
            return { kind: 'APIService', item: await SOURCES.APIService.get(input.name) };
        case 'FlowSchema':
            return { kind: 'FlowSchema', item: await SOURCES.FlowSchema.get(input.name) };
        case 'CustomResourceDefinition':
            return {
                kind: 'CustomResourceDefinition',
                item: await SOURCES.CustomResourceDefinition.get(input.name),
            };
    }
}
