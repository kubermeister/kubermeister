import type { V1ObjectMeta, V1OwnerReference, V1Pod } from '@kubernetes/client-node';
import type { OwnerChain, OwnerLink, PodOwnerKind } from '../../../shared/k8s/owners.js';
import { ownerPath } from '../../../shared/k8s/owners.js';
import type { Pod } from '../../../shared/k8s/pods.js';
import { registeredKindOf } from '../../../shared/k8s/registry.js';
import { controllerRef } from './controller.js';
import { apis, readOrNull } from '../client.js';
import { withK8s } from '../errors.js';
import { toPod, usageFor } from './pods.js';

/*
 * Ownership, resolved through the API's own owner references rather than through label selectors:
 * a selector says which pods a controller would adopt, references say which ones it actually has.
 * Two pods of two deployments can share labels; they can never share an owner reference.
 */

export { controllerRef };

const linkFor = (ref: V1OwnerReference, namespace: string): OwnerLink => ({
    apiVersion: ref.apiVersion,
    kind: ref.kind,
    name: ref.name,
    namespace,
    path: ownerPath(ref.apiVersion, ref.kind, ref.name, namespace),
});

/**
 * The chain above one object. A pod usually answers to a ReplicaSet which answers to a Deployment,
 * and a job's pod answers to the Job which may answer to a CronJob, so the walk continues through
 * exactly those two intermediaries and stops. Anything unreadable ends the chain rather than
 * failing it: a broken link higher up must not cost the screen the link it already has.
 */
export async function ownerChainOf(metadata: V1ObjectMeta | undefined, namespace: string): Promise<OwnerChain> {
    const direct = controllerRef(metadata);
    if (!direct) return [];
    const chain: OwnerChain = [linkFor(direct, namespace)];

    const parent = await parentOf(direct, namespace);
    if (parent) chain.push(linkFor(parent, namespace));
    return chain;
}

/**
 * The owner of an intermediate controller: a ReplicaSet's Deployment, a Job's CronJob. Only the
 * built-in kinds are read, since a custom `Job` of another group is not in the `batch` API.
 */
async function parentOf(ref: V1OwnerReference, namespace: string): Promise<V1OwnerReference | undefined> {
    const kind = registeredKindOf(ref.apiVersion, ref.kind);
    if (kind === 'ReplicaSet') {
        const rs = await readOrNull(() => apis().apps.readNamespacedReplicaSet({ name: ref.name, namespace }));
        return controllerRef(rs?.metadata);
    }
    if (kind === 'Job') {
        const job = await readOrNull(() => apis().batch.readNamespacedJob({ name: ref.name, namespace }));
        return controllerRef(job?.metadata);
    }
    return undefined;
}

export function getPodOwners(name: string, namespace: string): Promise<OwnerChain> {
    return withK8s('pods.owners', async () => {
        const pod = await readOrNull(() => apis().core.readNamespacedPod({ name, namespace }));
        return pod ? ownerChainOf(pod.metadata, namespace) : [];
    });
}

/** Pods whose controller reference names one of these uids. */
export function podsOwnedBy(pods: V1Pod[], uids: Set<string>): V1Pod[] {
    return pods.filter((pod) => {
        const ref = controllerRef(pod.metadata);
        return !!ref?.uid && uids.has(ref.uid);
    });
}

/**
 * The uids whose pods belong to this controller. A Deployment owns pods only through its
 * ReplicaSets and a CronJob only through its Jobs, so those are resolved first; the rest own their
 * pods directly.
 */
async function owningUids(kind: PodOwnerKind, name: string, namespace: string): Promise<Set<string>> {
    const read: Record<PodOwnerKind, () => Promise<{ metadata?: V1ObjectMeta }>> = {
        Deployment: () => apis().apps.readNamespacedDeployment({ name, namespace }),
        StatefulSet: () => apis().apps.readNamespacedStatefulSet({ name, namespace }),
        DaemonSet: () => apis().apps.readNamespacedDaemonSet({ name, namespace }),
        Job: () => apis().batch.readNamespacedJob({ name, namespace }),
        CronJob: () => apis().batch.readNamespacedCronJob({ name, namespace }),
    };

    const owner = await readOrNull(read[kind]);
    const uid = owner?.metadata?.uid;
    if (!uid) return new Set();

    if (kind === 'Deployment') {
        const { items } = await apis().apps.listNamespacedReplicaSet({ namespace });
        return new Set(
            items
                .filter((rs) => controllerRef(rs.metadata)?.uid === uid)
                .map((rs) => rs.metadata?.uid)
                .filter((id): id is string => !!id),
        );
    }
    if (kind === 'CronJob') {
        const { items } = await apis().batch.listNamespacedJob({ namespace });
        return new Set(
            items
                .filter((job) => controllerRef(job.metadata)?.uid === uid)
                .map((job) => job.metadata?.uid)
                .filter((id): id is string => !!id),
        );
    }
    return new Set([uid]);
}

/** The pods one controller currently has, as the same rows the pod list renders. */
export function listOwnedPods(kind: PodOwnerKind, name: string, namespace: string): Promise<Pod[]> {
    return withK8s('workloads.pods', async () => {
        const uids = await owningUids(kind, name, namespace);
        if (uids.size === 0) return [];
        const { items } = await apis().core.listNamespacedPod({ namespace });
        return podsOwnedBy(items, uids).map((pod) => toPod(pod, Date.now(), usageFor(pod)));
    });
}
