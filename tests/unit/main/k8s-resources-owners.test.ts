import { ApiException, type V1ObjectMeta, type V1Pod } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = { readNamespacedPod: vi.fn(), listNamespacedPod: vi.fn() };
const apps = {
    readNamespacedReplicaSet: vi.fn(),
    readNamespacedDeployment: vi.fn(),
    readNamespacedStatefulSet: vi.fn(),
    readNamespacedDaemonSet: vi.fn(),
    listNamespacedReplicaSet: vi.fn(),
};
const batch = { readNamespacedJob: vi.fn(), readNamespacedCronJob: vi.fn(), listNamespacedJob: vi.fn() };
const client = {
    apis: () => ({ core, apps, batch }),
    getActiveNamespace: vi.fn<() => string | null>(() => 'team-a'),
    readOrNull: async <T>(read: () => Promise<T>) => {
        try {
            return await read();
        } catch (error) {
            if (error instanceof ApiException && error.code === 404) return undefined;
            throw error;
        }
    },
};
vi.mock('../../../src/main/k8s/client.js', () => client);

const sampler = {
    containerUsage: vi.fn(() => undefined),
    podUsage: vi.fn(() => undefined),
    ensureSampler: vi.fn(),
    percent: vi.fn(() => null),
};
vi.mock('../../../src/main/k8s/sampler.js', () => sampler);

const owners = await import('../../../src/main/k8s/resources/owners.js');

const GROUP_VERSION: Record<string, string> = { Job: 'batch/v1', CronJob: 'batch/v1' };

/** A controller reference as the API writes one. */
const ref = (
    kind: string,
    name: string,
    uid: string,
    controller = true,
    apiVersion = GROUP_VERSION[kind] ?? 'apps/v1',
) => ({
    apiVersion,
    kind,
    name,
    uid,
    controller,
});

function pod(name: string, owner?: ReturnType<typeof ref>): V1Pod {
    const metadata: V1ObjectMeta = { name, namespace: 'team-a', ownerReferences: owner ? [owner] : undefined };
    return { metadata, spec: { containers: [] }, status: { phase: 'Running' } } as V1Pod;
}

beforeEach(() => {
    vi.clearAllMocks();
    core.readNamespacedPod.mockResolvedValue(pod('web-abc-1', ref('ReplicaSet', 'web-abc', 'rs-1')));
    apps.readNamespacedReplicaSet.mockResolvedValue({
        metadata: { name: 'web-abc', uid: 'rs-1', ownerReferences: [ref('Deployment', 'web', 'dep-1')] },
    });
    batch.readNamespacedJob.mockResolvedValue({
        metadata: { name: 'import', uid: 'job-1', ownerReferences: [ref('CronJob', 'nightly', 'cron-1')] },
    });
});

describe('controllerRef', () => {
    it('prefers the reference marked as controller, and falls back to the first', () => {
        const managed = ref('ReplicaSet', 'web-abc', 'rs-1');
        const other = ref('Custom', 'thing', 'x-1', false);
        expect(owners.controllerRef({ ownerReferences: [other, managed] })?.name).toBe('web-abc');
        expect(owners.controllerRef({ ownerReferences: [other] })?.name).toBe('thing');
        expect(owners.controllerRef({})).toBeUndefined();
        expect(owners.controllerRef(undefined)).toBeUndefined();
    });
});

describe('owner chain', () => {
    it('walks a pod up through its replica set to its deployment, with links to both screens', async () => {
        await expect(owners.getPodOwners('web-abc-1', 'team-a')).resolves.toEqual([
            {
                apiVersion: 'apps/v1',
                kind: 'ReplicaSet',
                name: 'web-abc',
                namespace: 'team-a',
                path: '/workloads/replicasets/team-a/web-abc',
            },
            {
                apiVersion: 'apps/v1',
                kind: 'Deployment',
                name: 'web',
                namespace: 'team-a',
                path: '/workloads/deployments/team-a/web',
            },
        ]);
    });

    it('walks a job pod up to its cron job', async () => {
        core.readNamespacedPod.mockResolvedValue(pod('import-xyz', ref('Job', 'import', 'job-1')));
        await expect(owners.getPodOwners('import-xyz', 'team-a')).resolves.toEqual([
            {
                apiVersion: 'batch/v1',
                kind: 'Job',
                name: 'import',
                namespace: 'team-a',
                path: '/workloads/jobs/team-a/import',
            },
            {
                apiVersion: 'batch/v1',
                kind: 'CronJob',
                name: 'nightly',
                namespace: 'team-a',
                path: '/workloads/cronjobs/team-a/nightly',
            },
        ]);
    });

    it('neither links nor walks through a custom kind named like a built-in one', async () => {
        const volcano = ref('Job', 'train', 'vj-1', true, 'batch.volcano.sh/v1alpha1');
        core.readNamespacedPod.mockResolvedValue(pod('train-0', volcano));
        await expect(owners.getPodOwners('train-0', 'team-a')).resolves.toEqual([
            { apiVersion: 'batch.volcano.sh/v1alpha1', kind: 'Job', name: 'train', namespace: 'team-a', path: null },
        ]);
        // The batch/v1 Job of the same name, if there is one, is somebody else's.
        expect(batch.readNamespacedJob).not.toHaveBeenCalled();

        const kruise = ref('ReplicaSet', 'db-abc', 'kr-1', true, 'apps.kruise.io/v1alpha1');
        core.readNamespacedPod.mockResolvedValue(pod('db-abc-0', kruise));
        const chain = await owners.getPodOwners('db-abc-0', 'team-a');
        expect(chain).toEqual([expect.objectContaining({ kind: 'ReplicaSet', path: null })]);
        expect(apps.readNamespacedReplicaSet).not.toHaveBeenCalled();
    });

    it('stops at a controller that owns its pods directly', async () => {
        core.readNamespacedPod.mockResolvedValue(pod('db-0', ref('StatefulSet', 'db', 'sts-1')));
        const chain = await owners.getPodOwners('db-0', 'team-a');
        expect(chain).toHaveLength(1);
        expect(chain[0]).toMatchObject({ kind: 'StatefulSet', path: '/workloads/statefulsets/team-a/db' });
        expect(apps.readNamespacedReplicaSet).not.toHaveBeenCalled();
    });

    it('answers with no chain for a pod nothing owns, and for a pod that is gone', async () => {
        core.readNamespacedPod.mockResolvedValue(pod('loose'));
        await expect(owners.getPodOwners('loose', 'team-a')).resolves.toEqual([]);
        core.readNamespacedPod.mockRejectedValue(new ApiException(404, 'gone', null, {}));
        await expect(owners.getPodOwners('ghost', 'team-a')).resolves.toEqual([]);
    });

    it('keeps the link it has when the one above cannot be read', async () => {
        apps.readNamespacedReplicaSet.mockRejectedValue(new ApiException(404, 'gone', null, {}));
        const chain = await owners.getPodOwners('web-abc-1', 'team-a');
        expect(chain).toEqual([
            {
                apiVersion: 'apps/v1',
                kind: 'ReplicaSet',
                name: 'web-abc',
                namespace: 'team-a',
                path: '/workloads/replicasets/team-a/web-abc',
            },
        ]);
    });
});

describe('pods of a controller', () => {
    const owned = [
        pod('web-abc-1', ref('ReplicaSet', 'web-abc', 'rs-1')),
        pod('web-abc-2', ref('ReplicaSet', 'web-abc', 'rs-1')),
        pod('other-1', ref('ReplicaSet', 'other', 'rs-9')),
        pod('loose'),
    ];

    beforeEach(() => {
        core.listNamespacedPod.mockResolvedValue({ items: owned });
        apps.readNamespacedDeployment.mockResolvedValue({ metadata: { name: 'web', uid: 'dep-1' } });
        apps.listNamespacedReplicaSet.mockResolvedValue({
            items: [
                { metadata: { name: 'web-abc', uid: 'rs-1', ownerReferences: [ref('Deployment', 'web', 'dep-1')] } },
                { metadata: { name: 'other', uid: 'rs-9', ownerReferences: [ref('Deployment', 'other', 'dep-9')] } },
            ],
        });
    });

    it('takes a deployment’s pods through its own replica sets, not by label', async () => {
        const pods = await owners.listOwnedPods('Deployment', 'web', 'team-a');
        expect(pods.map((p) => p.name)).toEqual(['web-abc-1', 'web-abc-2']);
    });

    it('takes a stateful set’s pods directly', async () => {
        apps.readNamespacedStatefulSet.mockResolvedValue({ metadata: { name: 'db', uid: 'sts-1' } });
        core.listNamespacedPod.mockResolvedValue({ items: [pod('db-0', ref('StatefulSet', 'db', 'sts-1'))] });
        await expect(owners.listOwnedPods('StatefulSet', 'db', 'team-a')).resolves.toMatchObject([{ name: 'db-0' }]);
        expect(apps.listNamespacedReplicaSet).not.toHaveBeenCalled();
    });

    it('takes a cron job’s pods through the jobs it created', async () => {
        batch.readNamespacedCronJob.mockResolvedValue({ metadata: { name: 'nightly', uid: 'cron-1' } });
        batch.listNamespacedJob.mockResolvedValue({
            items: [
                { metadata: { name: 'import', uid: 'job-1', ownerReferences: [ref('CronJob', 'nightly', 'cron-1')] } },
                { metadata: { name: 'unrelated', uid: 'job-9' } },
            ],
        });
        core.listNamespacedPod.mockResolvedValue({
            items: [
                pod('import-xyz', ref('Job', 'import', 'job-1')),
                pod('unrelated-1', ref('Job', 'unrelated', 'job-9')),
            ],
        });
        await expect(owners.listOwnedPods('CronJob', 'nightly', 'team-a')).resolves.toMatchObject([
            { name: 'import-xyz' },
        ]);
    });

    it('takes a daemon set’s and a job’s pods directly too', async () => {
        apps.readNamespacedDaemonSet.mockResolvedValue({ metadata: { name: 'agent', uid: 'ds-1' } });
        core.listNamespacedPod.mockResolvedValue({ items: [pod('agent-xyz', ref('DaemonSet', 'agent', 'ds-1'))] });
        await expect(owners.listOwnedPods('DaemonSet', 'agent', 'team-a')).resolves.toMatchObject([
            { name: 'agent-xyz' },
        ]);

        batch.readNamespacedJob.mockResolvedValue({ metadata: { name: 'import', uid: 'job-1' } });
        core.listNamespacedPod.mockResolvedValue({ items: [pod('import-xyz', ref('Job', 'import', 'job-1'))] });
        await expect(owners.listOwnedPods('Job', 'import', 'team-a')).resolves.toMatchObject([{ name: 'import-xyz' }]);
        expect(batch.listNamespacedJob).not.toHaveBeenCalled();
    });

    it('answers with nothing for a controller that is gone, without listing pods', async () => {
        apps.readNamespacedDeployment.mockRejectedValue(new ApiException(404, 'gone', null, {}));
        await expect(owners.listOwnedPods('Deployment', 'ghost', 'team-a')).resolves.toEqual([]);
        expect(core.listNamespacedPod).not.toHaveBeenCalled();
    });

    it('answers with nothing for a deployment whose replica sets are all someone else’s', async () => {
        apps.listNamespacedReplicaSet.mockResolvedValue({ items: [{ metadata: { name: 'other', uid: 'rs-9' } }] });
        await expect(owners.listOwnedPods('Deployment', 'web', 'team-a')).resolves.toEqual([]);
    });
});
