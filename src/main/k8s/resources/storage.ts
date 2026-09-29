import {
    ApiException,
    type V1ObjectMeta,
    type V1PersistentVolume,
    type V1PersistentVolumeClaim,
    type V1StorageClass,
} from '@kubernetes/client-node';
import type {
    Claim,
    ClaimDetail,
    ClaimStatus,
    Snapshot,
    SnapshotDetail,
    StorageClass,
    StorageClassDetail,
    Volume,
    VolumeDetail,
    VolumeStatus,
} from '../../../shared/k8s/storage.js';
import { apis, getNamespaced, listItems, readOrNull, resolveObjectNamespace } from '../client.js';
import { withK8s } from '../errors.js';
import { age, dash, toPairs } from '../format.js';

/*
 * Volumes and storage classes are cluster-scoped; claims and snapshots follow the active namespace.
 * Snapshots are a CRD: a cluster without it reports no snapshots rather than an error.
 */

const ACCESS_MODE_SHORT: Record<string, string> = {
    ReadWriteOnce: 'RWO',
    ReadOnlyMany: 'ROX',
    ReadWriteMany: 'RWX',
    ReadWriteOncePod: 'RWOP',
};

export function shortAccessModes(modes?: string[]): string {
    if (!modes?.length) return '—';
    return modes.map((mode) => ACCESS_MODE_SHORT[mode] ?? mode).join(',');
}

const VOLUME_PHASES = new Set<VolumeStatus>(['Bound', 'Available', 'Released', 'Failed', 'Pending']);
const CLAIM_PHASES = new Set<ClaimStatus>(['Bound', 'Pending', 'Lost']);

export function volumePhase(phase?: string): VolumeStatus {
    return VOLUME_PHASES.has(phase as VolumeStatus) ? (phase as VolumeStatus) : 'Unknown';
}

export function claimPhase(phase?: string): ClaimStatus {
    return CLAIM_PHASES.has(phase as ClaimStatus) ? (phase as ClaimStatus) : 'Unknown';
}

export function toVolume(volume: V1PersistentVolume, now = Date.now()): Volume {
    const claimRef = volume.spec?.claimRef;
    return {
        name: volume.metadata?.name ?? '',
        capacity: dash(volume.spec?.capacity?.storage),
        accessModes: shortAccessModes(volume.spec?.accessModes),
        reclaimPolicy: volume.spec?.persistentVolumeReclaimPolicy ?? 'Retain',
        status: volumePhase(volume.status?.phase),
        claim: claimRef ? `${claimRef.namespace}/${claimRef.name}` : '—',
        storageClass: dash(volume.spec?.storageClassName),
        age: age(volume.metadata?.creationTimestamp, now),
    };
}

export function toVolumeDetail(volume: V1PersistentVolume, now = Date.now()): VolumeDetail {
    return {
        ...toVolume(volume, now),
        labels: toPairs(volume.metadata?.labels),
        annotations: toPairs(volume.metadata?.annotations),
    };
}

export function toClaim(claim: V1PersistentVolumeClaim, now = Date.now()): Claim {
    const capacity = claim.status?.capacity?.storage ?? claim.spec?.resources?.requests?.storage;
    return {
        name: claim.metadata?.name ?? '',
        namespace: claim.metadata?.namespace ?? '',
        status: claimPhase(claim.status?.phase),
        volume: dash(claim.spec?.volumeName),
        capacity: dash(capacity),
        accessModes: shortAccessModes(claim.spec?.accessModes ?? claim.status?.accessModes),
        storageClass: dash(claim.spec?.storageClassName),
        age: age(claim.metadata?.creationTimestamp, now),
    };
}

export function toClaimDetail(claim: V1PersistentVolumeClaim, now = Date.now()): ClaimDetail {
    return {
        ...toClaim(claim, now),
        labels: toPairs(claim.metadata?.labels),
        annotations: toPairs(claim.metadata?.annotations),
    };
}

const DEFAULT_CLASS_ANNOTATIONS = [
    'storageclass.kubernetes.io/is-default-class',
    'storageclass.beta.kubernetes.io/is-default-class',
];

export function toStorageClass(storageClass: V1StorageClass, now = Date.now()): StorageClass {
    const annotations = storageClass.metadata?.annotations ?? {};
    return {
        name: storageClass.metadata?.name ?? '',
        provisioner: storageClass.provisioner,
        reclaimPolicy: storageClass.reclaimPolicy ?? 'Delete',
        volumeBinding: storageClass.volumeBindingMode ?? 'Immediate',
        isDefault: DEFAULT_CLASS_ANNOTATIONS.some((key) => annotations[key] === 'true'),
        age: age(storageClass.metadata?.creationTimestamp, now),
    };
}

export function toStorageClassDetail(storageClass: V1StorageClass, now = Date.now()): StorageClassDetail {
    return {
        ...toStorageClass(storageClass, now),
        labels: toPairs(storageClass.metadata?.labels),
        annotations: toPairs(storageClass.metadata?.annotations),
    };
}

export interface VolumeSnapshotObject {
    // The CRD's objects arrive untyped, so the fields the transforms read are stated here. It is
    // the client's own metadata shape, so a snapshot can be read wherever a typed object can.
    metadata?: V1ObjectMeta;
    spec?: { source?: { persistentVolumeClaimName?: string } };
    status?: { readyToUse?: boolean; restoreSize?: string; error?: { message?: string } };
}

export const SNAPSHOT_GROUP = { group: 'snapshot.storage.k8s.io', version: 'v1', plural: 'volumesnapshots' } as const;

/** A snapshot the controller reported an error for and never readied has failed; it will not become ready alone. */
function snapshotReady(status: VolumeSnapshotObject['status']): Snapshot['ready'] {
    if (status?.readyToUse) return 'Ready';
    return status?.error ? 'Failed' : 'Pending';
}

export function toSnapshot(object: VolumeSnapshotObject, now = Date.now()): Snapshot {
    const claim = object.spec?.source?.persistentVolumeClaimName;
    return {
        name: object.metadata?.name ?? '',
        namespace: object.metadata?.namespace ?? '',
        sourcePvc: claim ? `pvc/${claim}` : '—',
        restoreSize: dash(object.status?.restoreSize),
        ready: snapshotReady(object.status),
        age: age(object.metadata?.creationTimestamp, now),
    };
}

export function toSnapshotDetail(object: VolumeSnapshotObject, now = Date.now()): SnapshotDetail {
    return {
        ...toSnapshot(object, now),
        labels: toPairs(object.metadata?.labels),
        annotations: toPairs(object.metadata?.annotations),
    };
}

/** A cluster without the snapshot CRD reports no snapshots; any other failure still surfaces. */
export async function listSnapshotObjects(namespace?: string): Promise<VolumeSnapshotObject[]> {
    try {
        const { items } = await listItems<VolumeSnapshotObject>(
            namespace,
            (ns) =>
                apis().customObjects.listNamespacedCustomObject({ ...SNAPSHOT_GROUP, namespace: ns }) as Promise<{
                    items: VolumeSnapshotObject[];
                }>,
            () =>
                apis().customObjects.listClusterCustomObject(SNAPSHOT_GROUP) as Promise<{
                    items: VolumeSnapshotObject[];
                }>,
        );
        return items ?? [];
    } catch (error) {
        if (error instanceof ApiException && error.code === 404) return [];
        throw error;
    }
}

export function listVolumes(): Promise<Volume[]> {
    return withK8s('resources.list', async () => {
        const res = await apis().core.listPersistentVolume();
        return res.items.map((volume) => toVolume(volume));
    });
}

export function getVolume(name: string): Promise<VolumeDetail | null> {
    return withK8s('resources.get', async () => {
        const volume = await readOrNull(() => apis().core.readPersistentVolume({ name }));
        return volume ? toVolumeDetail(volume) : null;
    });
}

export function listClaims(namespace?: string): Promise<Claim[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().core.listNamespacedPersistentVolumeClaim({ namespace: ns }),
            () => apis().core.listPersistentVolumeClaimForAllNamespaces(),
        );
        return items.map((claim) => toClaim(claim));
    });
}

export function getClaim(name: string, namespace?: string): Promise<ClaimDetail | null> {
    return withK8s('resources.get', async () => {
        const claim = await getNamespaced(name, namespace, (n, ns) =>
            apis().core.readNamespacedPersistentVolumeClaim({ name: n, namespace: ns }),
        );
        return claim ? toClaimDetail(claim) : null;
    });
}

export function listStorageClasses(): Promise<StorageClass[]> {
    return withK8s('resources.list', async () => {
        const res = await apis().storage.listStorageClass();
        return res.items.map((storageClass) => toStorageClass(storageClass));
    });
}

export function getStorageClass(name: string): Promise<StorageClassDetail | null> {
    return withK8s('resources.get', async () => {
        const storageClass = await readOrNull(() => apis().storage.readStorageClass({ name }));
        return storageClass ? toStorageClassDetail(storageClass) : null;
    });
}

export function listSnapshots(namespace?: string): Promise<Snapshot[]> {
    return withK8s('resources.list', async () => {
        const items = await listSnapshotObjects(namespace);
        return items.map((object) => toSnapshot(object));
    });
}

export function getSnapshot(name: string, namespace?: string): Promise<SnapshotDetail | null> {
    return withK8s('resources.get', async () => {
        // No namespace means not found rather than the first same-named snapshot across the cluster.
        const ns = resolveObjectNamespace(namespace);
        if (!ns) return null;
        const object = await readOrNull(
            () =>
                apis().customObjects.getNamespacedCustomObject({
                    ...SNAPSHOT_GROUP,
                    namespace: ns,
                    name,
                }) as Promise<VolumeSnapshotObject>,
        );
        return object ? toSnapshotDetail(object) : null;
    });
}
