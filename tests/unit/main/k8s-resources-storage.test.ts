import {
    ApiException,
    type V1PersistentVolume,
    type V1PersistentVolumeClaim,
    type V1StorageClass,
} from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = {
    listPersistentVolume: vi.fn(),
    readPersistentVolume: vi.fn(),
    listNamespacedPersistentVolumeClaim: vi.fn(),
    listPersistentVolumeClaimForAllNamespaces: vi.fn(),
    readNamespacedPersistentVolumeClaim: vi.fn(),
};
const storageApi = { listStorageClass: vi.fn(), readStorageClass: vi.fn() };
const customObjects = {
    listNamespacedCustomObject: vi.fn(),
    listClusterCustomObject: vi.fn(),
    getNamespacedCustomObject: vi.fn(),
};
const client = {
    apis: () => ({ core, storage: storageApi, customObjects }),
    getActiveNamespace: vi.fn<() => string | null>(),
    resolveObjectNamespace: (explicit?: string) => explicit ?? client.getActiveNamespace(),
    isSafeSelectorValue: () => true,
    listItems: async <T>(
        ns: string | undefined,
        namespaced: (ns: string) => Promise<{ items: T[] }>,
        all: () => Promise<{ items: T[] }>,
    ) => {
        const resolved = ns ?? client.getActiveNamespace() ?? undefined;
        return resolved ? namespaced(resolved) : all();
    },
    readOrNull: async <T>(read: () => Promise<T>) => {
        try {
            return await read();
        } catch (error) {
            if (error instanceof ApiException && error.code === 404) return undefined;
            throw error;
        }
    },
    getNamespaced: async <T>(
        name: string,
        namespace: string | undefined,
        readOne: (name: string, ns: string) => Promise<T>,
    ) => {
        const ns = client.resolveObjectNamespace(namespace);
        if (!ns) return undefined;
        return client.readOrNull(() => readOne(name, ns));
    },
};
vi.mock('../../../src/main/k8s/client.js', () => client);

const storage = await import('../../../src/main/k8s/resources/storage.js');

const NOW = Date.parse('2026-09-15T12:00:00Z');
const HOUR = 3600 * 1000;

describe('storage transforms', () => {
    it('shortens access modes and maps phases, falling back to Unknown', () => {
        expect(storage.shortAccessModes(['ReadWriteOnce', 'ReadOnlyMany'])).toBe('RWO,ROX');
        expect(storage.shortAccessModes(['Exotic'])).toBe('Exotic');
        expect(storage.shortAccessModes([])).toBe('—');
        expect(storage.shortAccessModes()).toBe('—');
        expect(storage.volumePhase('Released')).toBe('Released');
        expect(storage.volumePhase('Sleeping')).toBe('Unknown');
        expect(storage.claimPhase('Lost')).toBe('Lost');
        expect(storage.claimPhase(undefined)).toBe('Unknown');
    });

    it('builds a volume row from its spec, claim reference and phase', () => {
        const volume = {
            metadata: { name: 'pvc-1', creationTimestamp: new Date(NOW - HOUR), labels: { tier: 'db' } },
            spec: {
                capacity: { storage: '10Gi' },
                accessModes: ['ReadWriteOnce'],
                persistentVolumeReclaimPolicy: 'Delete',
                claimRef: { namespace: 'team-a', name: 'data' },
                storageClassName: 'local-path',
            },
            status: { phase: 'Bound' },
        } as V1PersistentVolume;
        expect(storage.toVolume(volume, NOW)).toEqual({
            name: 'pvc-1',
            capacity: '10Gi',
            accessModes: 'RWO',
            reclaimPolicy: 'Delete',
            status: 'Bound',
            claim: 'team-a/data',
            storageClass: 'local-path',
            age: '1h',
        });
        expect(storage.toVolumeDetail(volume, NOW)).toMatchObject({ labels: [['tier', 'db']] });
        expect(storage.toVolume({ metadata: { name: 'bare' } }, NOW)).toMatchObject({
            capacity: '—',
            reclaimPolicy: 'Retain',
            claim: '—',
            status: 'Unknown',
        });
    });

    it('builds a claim row, preferring the bound capacity over the request', () => {
        const claim = {
            metadata: { name: 'data', namespace: 'team-a', creationTimestamp: new Date(NOW - HOUR) },
            spec: {
                accessModes: ['ReadWriteOnce'],
                storageClassName: 'local-path',
                resources: { requests: { storage: '5Gi' } },
            },
            status: { phase: 'Bound', capacity: { storage: '10Gi' } },
        } as V1PersistentVolumeClaim;
        expect(storage.toClaim(claim, NOW)).toMatchObject({ capacity: '10Gi', status: 'Bound', volume: '—' });
        const pending = storage.toClaim(
            {
                metadata: { name: 'p' },
                spec: { resources: { requests: { storage: '1Gi' } } },
                status: { phase: 'Pending' },
            },
            NOW,
        );
        expect(pending).toMatchObject({ capacity: '1Gi', status: 'Pending', accessModes: '—' });
        expect(storage.toClaimDetail(claim, NOW)).toMatchObject({ annotations: [] });
    });

    it('marks the default storage class from either annotation', () => {
        const base = {
            metadata: { name: 'local-path', creationTimestamp: new Date(NOW - HOUR) },
            provisioner: 'rancher.io/local-path',
            reclaimPolicy: 'Delete',
            volumeBindingMode: 'WaitForFirstConsumer',
        } as V1StorageClass;
        expect(storage.toStorageClass(base, NOW)).toEqual({
            name: 'local-path',
            provisioner: 'rancher.io/local-path',
            reclaimPolicy: 'Delete',
            volumeBinding: 'WaitForFirstConsumer',
            isDefault: false,
            age: '1h',
        });
        for (const key of [
            'storageclass.kubernetes.io/is-default-class',
            'storageclass.beta.kubernetes.io/is-default-class',
        ]) {
            const annotated = { ...base, metadata: { ...base.metadata, annotations: { [key]: 'true' } } };
            expect(storage.toStorageClass(annotated, NOW).isDefault).toBe(true);
        }
        expect(
            storage.toStorageClass({ metadata: { name: 'x' }, provisioner: 'p' } as V1StorageClass, NOW),
        ).toMatchObject({ reclaimPolicy: 'Delete', volumeBinding: 'Immediate' });
        expect(storage.toStorageClassDetail(base, NOW)).toMatchObject({ labels: [] });
    });

    it('names the snapshot source and readiness', () => {
        const object = {
            metadata: { name: 'snap', namespace: 'team-a', creationTimestamp: new Date(NOW - HOUR).toISOString() },
            spec: { source: { persistentVolumeClaimName: 'data' } },
            status: { readyToUse: true, restoreSize: '10Gi' },
        };
        expect(storage.toSnapshot(object, NOW)).toEqual({
            name: 'snap',
            namespace: 'team-a',
            sourcePvc: 'pvc/data',
            restoreSize: '10Gi',
            ready: 'Ready',
            age: '1h',
        });
        expect(storage.toSnapshot({ metadata: { name: 'x' } }, NOW)).toMatchObject({
            sourcePvc: '—',
            restoreSize: '—',
            ready: 'Pending',
        });
        expect(storage.toSnapshotDetail(object, NOW)).toMatchObject({ labels: [], annotations: [] });
    });

    it('reads a snapshot the controller reported an error for as Failed', () => {
        const failed = { metadata: { name: 'x' }, status: { readyToUse: false, error: { message: 'no space' } } };
        expect(storage.toSnapshot(failed, NOW).ready).toBe('Failed');
        const recovered = { metadata: { name: 'x' }, status: { readyToUse: true, error: { message: 'retried' } } };
        expect(storage.toSnapshot(recovered, NOW).ready).toBe('Ready');
    });
});

describe('storage readers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        client.getActiveNamespace.mockReturnValue('team-a');
        core.listPersistentVolume.mockResolvedValue({ items: [{ metadata: { name: 'pv-1' }, spec: {}, status: {} }] });
        core.readPersistentVolume.mockResolvedValue({ metadata: { name: 'pv-1' }, spec: {}, status: {} });
        core.listNamespacedPersistentVolumeClaim.mockResolvedValue({
            items: [{ metadata: { name: 'data', namespace: 'team-a' } }],
        });
        core.listPersistentVolumeClaimForAllNamespaces.mockResolvedValue({ items: [] });
        core.readNamespacedPersistentVolumeClaim.mockResolvedValue({ metadata: { name: 'data', namespace: 'team-a' } });
        storageApi.listStorageClass.mockResolvedValue({
            items: [{ metadata: { name: 'local-path' }, provisioner: 'p' }],
        });
        storageApi.readStorageClass.mockResolvedValue({ metadata: { name: 'local-path' }, provisioner: 'p' });
        customObjects.listNamespacedCustomObject.mockResolvedValue({
            items: [{ metadata: { name: 'snap', namespace: 'team-a' } }],
        });
        customObjects.listClusterCustomObject.mockResolvedValue({ items: [] });
        customObjects.getNamespacedCustomObject.mockResolvedValue({ metadata: { name: 'snap', namespace: 'team-a' } });
    });

    it('reads the cluster-scoped kinds without a namespace', async () => {
        expect((await storage.listVolumes()).map((v) => v.name)).toEqual(['pv-1']);
        expect(core.listPersistentVolume).toHaveBeenCalledWith();
        await expect(storage.getVolume('pv-1')).resolves.toMatchObject({ name: 'pv-1' });
        expect((await storage.listStorageClasses()).map((c) => c.name)).toEqual(['local-path']);
        await expect(storage.getStorageClass('local-path')).resolves.toMatchObject({ provisioner: 'p' });
        core.readPersistentVolume.mockRejectedValue(new ApiException(404, 'x', null, {}));
        await expect(storage.getVolume('gone')).resolves.toBeNull();
        storageApi.readStorageClass.mockRejectedValue(new ApiException(404, 'x', null, {}));
        await expect(storage.getStorageClass('gone')).resolves.toBeNull();
    });

    it('reads claims in the active or all namespaces', async () => {
        expect((await storage.listClaims()).map((c) => c.name)).toEqual(['data']);
        expect(core.listNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({ namespace: 'team-a' });
        await expect(storage.getClaim('data', 'team-a')).resolves.toMatchObject({ name: 'data' });
        client.getActiveNamespace.mockReturnValue(null);
        await expect(storage.listClaims()).resolves.toEqual([]);
        expect(core.listPersistentVolumeClaimForAllNamespaces).toHaveBeenCalled();
    });

    it('treats a missing snapshot CRD as no snapshots but still raises other failures', async () => {
        expect((await storage.listSnapshots()).map((s) => s.name)).toEqual(['snap']);
        await expect(storage.getSnapshot('snap', 'team-a')).resolves.toMatchObject({ name: 'snap' });
        customObjects.listNamespacedCustomObject.mockRejectedValue(new ApiException(404, 'x', null, {}));
        await expect(storage.listSnapshots()).resolves.toEqual([]);
        customObjects.listNamespacedCustomObject.mockRejectedValue(
            new ApiException(403, 'x', { message: 'denied' }, {}),
        );
        await expect(storage.listSnapshots()).rejects.toMatchObject({ kind: 'forbidden', op: 'resources.list' });
    });

    it('answers null for a snapshot when no namespace is known, without searching the cluster', async () => {
        client.getActiveNamespace.mockReturnValue(null);
        customObjects.listClusterCustomObject.mockResolvedValue({
            items: [{ metadata: { name: 'snap', namespace: 'b' } }],
        });
        await expect(storage.getSnapshot('snap')).resolves.toBeNull();
        expect(customObjects.listClusterCustomObject).not.toHaveBeenCalled();
        expect(customObjects.getNamespacedCustomObject).not.toHaveBeenCalled();
    });

    it('classifies failures under the generic ops', async () => {
        core.listPersistentVolume.mockRejectedValue(new ApiException(403, 'x', { message: 'denied' }, {}));
        await expect(storage.listVolumes()).rejects.toMatchObject({ kind: 'forbidden', op: 'resources.list' });
    });
});
