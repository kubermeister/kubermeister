import {
    ApiException,
    type V1DaemonSet,
    type V1Deployment,
    type V1ReplicaSet,
    type V1StatefulSet,
} from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apps = {
    listNamespacedDeployment: vi.fn(),
    listDeploymentForAllNamespaces: vi.fn(),
    readNamespacedDeployment: vi.fn(),
    listNamespacedReplicaSet: vi.fn(),
    listReplicaSetForAllNamespaces: vi.fn(),
    readNamespacedReplicaSet: vi.fn(),
    patchNamespacedDeployment: vi.fn(),
    listNamespacedStatefulSet: vi.fn(),
    listStatefulSetForAllNamespaces: vi.fn(),
    readNamespacedStatefulSet: vi.fn(),
    listNamespacedDaemonSet: vi.fn(),
    listDaemonSetForAllNamespaces: vi.fn(),
    readNamespacedDaemonSet: vi.fn(),
};
const batch = {
    listNamespacedJob: vi.fn(),
    listJobForAllNamespaces: vi.fn(),
    readNamespacedJob: vi.fn(),
    listNamespacedCronJob: vi.fn(),
    listCronJobForAllNamespaces: vi.fn(),
    readNamespacedCronJob: vi.fn(),
};
const hpa = {
    listNamespacedHorizontalPodAutoscaler: vi.fn(),
    listHorizontalPodAutoscalerForAllNamespaces: vi.fn(),
    readNamespacedHorizontalPodAutoscaler: vi.fn(),
};
const core = {
    listNamespacedReplicationController: vi.fn(),
    listReplicationControllerForAllNamespaces: vi.fn(),
    readNamespacedReplicationController: vi.fn(),
};
const objects = { patch: vi.fn() };
const client = {
    apis: () => ({ apps, batch, core, hpa, objects }),
    activeContextName: vi.fn<() => string>(() => 'alpha'),
    getActiveNamespace: vi.fn<() => string | null>(),
    resolveObjectNamespace: (explicit?: string) => explicit ?? client.getActiveNamespace(),
    isSafeSelectorValue: (value: string) => /^[A-Za-z0-9._-]+$/.test(value),
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

const workloads = await import('../../../src/main/k8s/resources/workloads.js');

const NOW = Date.parse('2026-09-15T12:00:00Z');
const HOUR = 3600 * 1000;

function deployment(overrides: Partial<V1Deployment> = {}): V1Deployment {
    return {
        metadata: {
            name: 'web',
            namespace: 'team-a',
            uid: 'dep-1',
            creationTimestamp: new Date(NOW - 3 * 24 * HOUR),
            labels: { app: 'web' },
            annotations: {
                'deployment.kubernetes.io/revision': '2',
                'kubectl.kubernetes.io/last-applied-configuration': '{}',
            },
        },
        spec: {
            replicas: 3,
            selector: { matchLabels: { app: 'web' } },
            strategy: { type: 'Recreate' },
            template: { spec: { containers: [{ name: 'web', image: 'nginx:1.27' }] } },
        },
        status: { replicas: 3, readyReplicas: 2, updatedReplicas: 3, availableReplicas: 2 },
        ...overrides,
    } as V1Deployment;
}
function replicaSet(revision: string, overrides: Partial<V1ReplicaSet> = {}): V1ReplicaSet {
    return {
        metadata: {
            name: `web-${revision}`,
            namespace: 'team-a',
            ownerReferences: [{ uid: 'dep-1', kind: 'Deployment', name: 'web', apiVersion: 'apps/v1' }],
            annotations: {
                'deployment.kubernetes.io/revision': revision,
                'kubernetes.io/change-cause': `cause ${revision}`,
            },
            creationTimestamp: new Date(NOW - Number(revision) * HOUR),
        },
        spec: {
            replicas: revision === '2' ? 3 : 0,
            template: { spec: { containers: [{ name: 'web', image: `nginx:1.2${revision}` }] } },
        },
        status: { replicas: revision === '2' ? 3 : 0, readyReplicas: revision === '2' ? 3 : 0 },
        ...overrides,
    } as V1ReplicaSet;
}

describe('deployment transforms', () => {
    it('derives status from replica counts', () => {
        expect(workloads.deploymentStatus(0, 0)).toBe('Available');
        expect(workloads.deploymentStatus(3, 3)).toBe('Healthy');
        expect(workloads.deploymentStatus(3, 4)).toBe('Healthy');
        expect(workloads.deploymentStatus(3, 2)).toBe('Progressing');
    });

    it('builds the row with ready ratio, counts, strategy and first image', () => {
        expect(workloads.toDeployment(deployment(), NOW)).toEqual({
            name: 'web',
            namespace: 'team-a',
            status: 'Progressing',
            ready: '2/3',
            replicas: 3,
            updated: 3,
            available: 2,
            strategy: 'Recreate',
            image: 'nginx:1.27',
            paused: false,
            age: '3d',
        });
    });

    it('falls back to status replicas, RollingUpdate and dashes when the spec is sparse', () => {
        const bare = workloads.toDeployment(
            { metadata: { name: 'x' }, status: { replicas: 2, availableReplicas: 2 } },
            NOW,
        );
        expect(bare).toMatchObject({
            namespace: '',
            status: 'Healthy',
            ready: '0/2',
            replicas: 2,
            strategy: 'RollingUpdate',
            image: '—',
        });
    });

    it('adds label and annotation pairs on the detail, without the last-applied blob', () => {
        const detail = workloads.toDeploymentDetail(deployment(), NOW);
        expect(detail.labels).toEqual([['app', 'web']]);
        expect(detail.annotations).toEqual([['deployment.kubernetes.io/revision', '2']]);
    });

    it('keeps only the ReplicaSets the deployment owns', () => {
        const foreign = replicaSet('9', { metadata: { name: 'other', ownerReferences: [{ uid: 'else' } as never] } });
        expect(
            workloads.ownedReplicaSets(deployment(), [replicaSet('1'), foreign]).map((rs) => rs.metadata?.name),
        ).toEqual(['web-1']);
        expect(workloads.toReplicaSet(replicaSet('2'), NOW)).toEqual({
            name: 'web-2',
            desired: 3,
            current: 3,
            ready: 3,
            age: '2h',
        });
    });

    it('orders rollouts newest first and marks the deployment revision current', () => {
        const rollouts = workloads.toRollouts(deployment(), [replicaSet('1'), replicaSet('2')], NOW);
        expect(rollouts.map((r) => [r.rev, r.state, r.image, r.by])).toEqual([
            ['2', 'Current', 'nginx:1.22', 'cause 2'],
            ['1', 'Superseded', 'nginx:1.21', 'cause 1'],
        ]);
        expect(rollouts[0]?.when).toMatch(/ago|h/);
        const unannotated = replicaSet('0', {
            metadata: { name: 'plain', ownerReferences: [{ uid: 'dep-1' } as never] },
        });
        expect(workloads.toRollouts(deployment(), [unannotated], NOW)[0]).toMatchObject({
            rev: '0',
            state: 'Superseded',
            by: '—',
        });
    });
});

describe('rollout status and rollback transforms', () => {
    it('reports a paused rollout as Paused whatever the replica counts say', () => {
        const held = deployment({ spec: { replicas: 3, paused: true } } as Partial<V1Deployment>);
        expect(workloads.deploymentStatus(3, 3, true)).toBe('Paused');
        expect(workloads.toDeployment(held, NOW)).toMatchObject({ status: 'Paused', paused: true });
        expect(workloads.toDeployment(deployment(), NOW).paused).toBe(false);
    });

    it('builds the live picture: counts, conditions and a role for each generation', () => {
        const rolling = deployment({
            status: {
                replicas: 3,
                readyReplicas: 2,
                updatedReplicas: 2,
                availableReplicas: 2,
                unavailableReplicas: 1,
                conditions: [
                    {
                        type: 'Progressing',
                        status: 'True',
                        reason: 'ReplicaSetUpdated',
                        message: 'rolling',
                        lastTransitionTime: new Date(NOW - HOUR),
                    },
                    { type: 'Available', status: 'False', lastTransitionTime: new Date(NOW - HOUR) },
                ],
            },
        } as Partial<V1Deployment>);
        const status = workloads.toRolloutStatus(rolling, [replicaSet('1'), replicaSet('2')], NOW);
        expect(status).toMatchObject({
            paused: false,
            desired: 3,
            updated: 2,
            ready: 2,
            available: 2,
            unavailable: 1,
            settled: false,
        });
        // Newest revision first, and the one the deployment points at is what it rolls towards.
        expect(status.sets.map((set) => [set.rev, set.role])).toEqual([
            ['2', 'new'],
            ['1', 'old'],
        ]);
        expect(status.conditions[0]).toMatchObject({ type: 'Progressing', status: 'True', message: 'rolling' });
        // A condition the server left blank reads as a dash rather than an empty cell.
        expect(status.conditions[1]).toMatchObject({ reason: '—', message: '—' });
    });

    it('settles only when every replica is updated and available', () => {
        const done = deployment({
            status: { replicas: 3, readyReplicas: 3, updatedReplicas: 3, availableReplicas: 3 },
        } as Partial<V1Deployment>);
        expect(workloads.toRolloutStatus(done, [replicaSet('2')], NOW).settled).toBe(true);
        expect(workloads.toRolloutStatus(deployment(), [replicaSet('2')], NOW).settled).toBe(false);
    });

    it('restores a revision without the hash label the controller maintains', () => {
        const hashed = replicaSet('1', {
            spec: {
                replicas: 0,
                template: {
                    metadata: { labels: { app: 'web', 'pod-template-hash': 'abc123' } },
                    spec: { containers: [{ name: 'web', image: 'nginx:1.21' }] },
                },
            },
        } as Partial<V1ReplicaSet>);
        const template = workloads.templateForRollback(hashed);
        expect(template.metadata?.labels).toEqual({ app: 'web' });
        // The ReplicaSet itself is left alone; only the copy that goes back loses the label.
        expect(hashed.spec?.template?.metadata?.labels?.['pod-template-hash']).toBe('abc123');
    });

    it('keeps the deployment’s rollout bookkeeping and takes the rest from the revision', () => {
        const target = replicaSet('1', {
            metadata: {
                name: 'web-1',
                ownerReferences: [{ uid: 'dep-1' } as never],
                annotations: {
                    'deployment.kubernetes.io/revision': '1',
                    'deployment.kubernetes.io/desired-replicas': '9',
                    'kubernetes.io/change-cause': 'first release',
                },
            },
        });
        expect(workloads.annotationsForRollback(deployment(), target)).toEqual({
            // The deployment's own values for the keys that describe the rollout, not the set's.
            'deployment.kubernetes.io/revision': '2',
            'kubectl.kubernetes.io/last-applied-configuration': '{}',
            'kubernetes.io/change-cause': 'first release',
        });
    });

    it('sees through the hash label when comparing a revision with the live template', () => {
        const live = deployment();
        const same = replicaSet('2', {
            spec: {
                template: {
                    metadata: { labels: { 'pod-template-hash': 'xyz' } },
                    spec: { containers: [{ name: 'web', image: 'nginx:1.27' }] },
                },
            },
        } as Partial<V1ReplicaSet>);
        expect(workloads.sameTemplate(live.spec, same.spec)).toBe(true);
        expect(workloads.sameTemplate(live.spec, replicaSet('1').spec)).toBe(false);
    });

    it('replaces the template wholesale rather than merging it', () => {
        const patch = workloads.rollbackPatch(deployment(), replicaSet('1'));
        expect(patch.map((op) => [op.op, op.path])).toEqual([
            ['replace', '/spec/template'],
            ['replace', '/metadata/annotations'],
        ]);
    });
});

describe('rollout writes', () => {
    const ON_ALPHA = { context: 'alpha', name: 'web', namespace: 'team-a' };

    beforeEach(() => {
        vi.clearAllMocks();
        client.getActiveNamespace.mockReturnValue('team-a');
        client.activeContextName.mockReturnValue('alpha');
        apps.readNamespacedDeployment.mockResolvedValue(deployment());
        apps.listNamespacedReplicaSet.mockResolvedValue({ items: [replicaSet('1'), replicaSet('2')] });
        apps.patchNamespacedDeployment.mockResolvedValue({});
        objects.patch.mockResolvedValue({});
    });

    it('reads the live rollout picture and answers null for a deployment that is gone', async () => {
        await expect(workloads.getDeploymentRolloutStatus('web', 'team-a')).resolves.toMatchObject({
            desired: 3,
            updated: 3,
            sets: [expect.objectContaining({ rev: '2', role: 'new' }), expect.objectContaining({ rev: '1' })],
        });
        apps.readNamespacedDeployment.mockRejectedValue(new ApiException(404, 'x', null, {}));
        await expect(workloads.getDeploymentRolloutStatus('gone', 'team-a')).resolves.toBeNull();
    });

    it('rolls back by restoring the revision’s template through a JSON patch', async () => {
        await expect(workloads.rollbackDeployment({ ...ON_ALPHA, revision: '1' })).resolves.toEqual({
            kind: 'Deployment',
            name: 'web',
            namespace: 'team-a',
            revision: '1',
            skipped: false,
        });
        const [call] = apps.patchNamespacedDeployment.mock.calls;
        expect(call[0]).toMatchObject({ name: 'web', namespace: 'team-a' });
        expect(call[0].body[0]).toMatchObject({
            op: 'replace',
            path: '/spec/template',
            value: { spec: { containers: [{ image: 'nginx:1.21' }] } },
        });
    });

    it('writes nothing when the revision’s template is already the live one', async () => {
        // The current generation carries the deployment's own template, plus the controller's hash.
        const current = replicaSet('2', {
            spec: {
                replicas: 3,
                template: {
                    metadata: { labels: { 'pod-template-hash': 'abc' } },
                    spec: { containers: [{ name: 'web', image: 'nginx:1.27' }] },
                },
            },
        } as Partial<V1ReplicaSet>);
        apps.listNamespacedReplicaSet.mockResolvedValue({ items: [replicaSet('1'), current] });
        await expect(workloads.rollbackDeployment({ ...ON_ALPHA, revision: '2' })).resolves.toMatchObject({
            skipped: true,
        });
        expect(apps.patchNamespacedDeployment).not.toHaveBeenCalled();
    });

    it('refuses a revision the deployment never had', async () => {
        await expect(workloads.rollbackDeployment({ ...ON_ALPHA, revision: '9' })).rejects.toMatchObject({
            kind: 'notFound',
            detail: expect.stringContaining('no revision 9'),
        });
        expect(apps.patchNamespacedDeployment).not.toHaveBeenCalled();
    });

    it('refuses to roll back or pause a deployment that is gone', async () => {
        apps.readNamespacedDeployment.mockRejectedValue(new ApiException(404, 'x', null, {}));
        const expected = { kind: 'notFound', detail: expect.stringContaining('was not found') };
        await expect(workloads.rollbackDeployment({ ...ON_ALPHA, revision: '1' })).rejects.toMatchObject(expected);
        await expect(workloads.setDeploymentPaused({ ...ON_ALPHA, paused: true })).rejects.toMatchObject(expected);
        expect(objects.patch).not.toHaveBeenCalled();
    });

    it('refuses both writes when the screen’s context is no longer the active one', async () => {
        client.activeContextName.mockReturnValue('beta');
        const expected = { kind: 'conflict', detail: expect.stringContaining('meant for context "alpha"') };
        await expect(workloads.rollbackDeployment({ ...ON_ALPHA, revision: '1' })).rejects.toMatchObject(expected);
        await expect(workloads.setDeploymentPaused({ ...ON_ALPHA, paused: true })).rejects.toMatchObject(expected);
        expect(apps.patchNamespacedDeployment).not.toHaveBeenCalled();
        expect(objects.patch).not.toHaveBeenCalled();
    });

    it('pauses and resumes through the deployment’s own pause flag', async () => {
        await expect(workloads.setDeploymentPaused({ ...ON_ALPHA, paused: true })).resolves.toEqual({
            kind: 'Deployment',
            name: 'web',
            namespace: 'team-a',
        });
        expect(objects.patch).toHaveBeenCalledWith({
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'web', namespace: 'team-a' },
            spec: { paused: true },
        });
        await workloads.setDeploymentPaused({ ...ON_ALPHA, paused: false });
        expect(objects.patch).toHaveBeenLastCalledWith(expect.objectContaining({ spec: { paused: false } }));
    });
});

describe('statefulset and daemonset transforms', () => {
    it('builds the statefulset row and detail', () => {
        const s = {
            metadata: {
                name: 'db',
                namespace: 'team-a',
                creationTimestamp: new Date(NOW - HOUR),
                labels: { tier: 'db' },
            },
            spec: {
                replicas: 2,
                serviceName: 'db-headless',
                template: { spec: { containers: [{ name: 'pg', image: 'postgres:16' }] } },
            },
            status: { replicas: 2, readyReplicas: 2 },
        } as V1StatefulSet;
        expect(workloads.toStatefulSet(s, NOW)).toEqual({
            name: 'db',
            namespace: 'team-a',
            ready: '2/2',
            replicas: 2,
            service: 'db-headless',
            image: 'postgres:16',
            age: '1h',
        });
        expect(workloads.toStatefulSetDetail(s, NOW)).toMatchObject({ labels: [['tier', 'db']], annotations: [] });
        expect(workloads.toStatefulSet({ metadata: { name: 'x' } }, NOW)).toMatchObject({
            ready: '0/0',
            service: '—',
            image: '—',
        });
    });

    it('builds the daemonset row with scheduling counts and the node selector', () => {
        const d = {
            metadata: { name: 'agent', namespace: 'kube-system', creationTimestamp: new Date(NOW - 2 * HOUR) },
            spec: { template: { spec: { nodeSelector: { 'kubernetes.io/os': 'linux' } } } },
            status: { desiredNumberScheduled: 3, currentNumberScheduled: 3, numberReady: 2, updatedNumberScheduled: 3 },
        } as V1DaemonSet;
        expect(workloads.toDaemonSet(d, NOW)).toEqual({
            name: 'agent',
            namespace: 'kube-system',
            desired: 3,
            current: 3,
            ready: 2,
            upToDate: 3,
            nodeSelector: 'kubernetes.io/os=linux',
            age: '2h',
        });
        expect(workloads.toDaemonSetDetail(d, NOW)).toMatchObject({ labels: [], annotations: [] });
        expect(workloads.toDaemonSet({ metadata: { name: 'x' } }, NOW)).toMatchObject({
            desired: 0,
            nodeSelector: '<none>',
        });
    });
});

describe('replica set and replication controller transforms', () => {
    const rs = {
        metadata: {
            name: 'web-7d9',
            namespace: 'team-a',
            creationTimestamp: new Date(NOW - HOUR),
            labels: { app: 'web' },
            ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', uid: 'd1', controller: true }],
        },
        spec: { replicas: 3, template: { spec: { containers: [{ name: 'web', image: 'nginx:1.27' }] } } },
        status: { replicas: 3, readyReplicas: 2 },
    } as V1ReplicaSet;

    it('names the controller above the set, which is the only way to tell two rollouts apart', () => {
        expect(workloads.toReplicaSetRow(rs, NOW)).toEqual({
            name: 'web-7d9',
            namespace: 'team-a',
            owner: 'Deployment/web',
            desired: 3,
            current: 3,
            ready: 2,
            image: 'nginx:1.27',
            age: '1h',
        });
        expect(workloads.toReplicaSetDetail(rs, NOW)).toMatchObject({ labels: [['app', 'web']], annotations: [] });
    });

    it('dashes the owner of a set nobody controls, and the image of one with no containers', () => {
        expect(workloads.toReplicaSetRow({ metadata: { name: 'orphan' } }, NOW)).toMatchObject({
            owner: '—',
            image: '—',
            namespace: '',
            desired: 0,
        });
    });

    it('reads a replication controller as the same row', () => {
        const rc = {
            metadata: { name: 'legacy', namespace: 'team-a', creationTimestamp: new Date(NOW - 2 * HOUR) },
            spec: { replicas: 1, template: { spec: { containers: [{ name: 'app', image: 'busybox:1.36' }] } } },
            status: { replicas: 1, readyReplicas: 1 },
        };
        expect(workloads.toReplicationController(rc, NOW)).toEqual({
            name: 'legacy',
            namespace: 'team-a',
            owner: '—',
            desired: 1,
            current: 1,
            ready: 1,
            image: 'busybox:1.36',
            age: '2h',
        });
        expect(workloads.toReplicationControllerDetail(rc, NOW)).toMatchObject({ labels: [], annotations: [] });
        expect(workloads.toReplicationController({}, NOW)).toMatchObject({ name: '', desired: 0, age: '—' });
    });
});

describe('readers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        client.getActiveNamespace.mockReturnValue('team-a');
        apps.listNamespacedDeployment.mockResolvedValue({ items: [deployment()] });
        apps.listDeploymentForAllNamespaces.mockResolvedValue({
            items: [deployment(), deployment({ metadata: { name: 'other', namespace: 'b' } })],
        });
        apps.readNamespacedDeployment.mockResolvedValue(deployment());
        apps.listNamespacedReplicaSet.mockResolvedValue({ items: [replicaSet('1'), replicaSet('2')] });
        apps.listNamespacedStatefulSet.mockResolvedValue({ items: [] });
        apps.listStatefulSetForAllNamespaces.mockResolvedValue({ items: [] });
        apps.readNamespacedStatefulSet.mockResolvedValue({ metadata: { name: 'db', namespace: 'team-a' } });
        apps.listNamespacedDaemonSet.mockResolvedValue({ items: [] });
        apps.listDaemonSetForAllNamespaces.mockResolvedValue({ items: [] });
        apps.readNamespacedDaemonSet.mockRejectedValue(new ApiException(404, 'x', null, {}));
    });

    it('lists deployments in the explicit, active or all namespaces', async () => {
        expect((await workloads.listDeployments('explicit')).map((d) => d.name)).toEqual(['web']);
        expect(apps.listNamespacedDeployment).toHaveBeenCalledWith({ namespace: 'explicit' });
        client.getActiveNamespace.mockReturnValue(null);
        expect((await workloads.listDeployments()).map((d) => d.namespace)).toEqual(['team-a', 'b']);
    });

    it('gets a deployment with its replicasets and rollouts, and returns empties for a missing one', async () => {
        await expect(workloads.getDeployment('web', 'team-a')).resolves.toMatchObject({
            name: 'web',
            labels: [['app', 'web']],
        });
        await expect(workloads.getDeploymentReplicaSets('web', 'team-a')).resolves.toHaveLength(2);
        expect(apps.listNamespacedReplicaSet).toHaveBeenCalledWith({ namespace: 'team-a' });
        const rollouts = await workloads.getDeploymentRollouts('web', 'team-a');
        expect(rollouts.map((r) => r.state)).toEqual(['Current', 'Superseded']);
        apps.readNamespacedDeployment.mockRejectedValue(new ApiException(404, 'x', null, {}));
        await expect(workloads.getDeployment('gone', 'team-a')).resolves.toBeNull();
        await expect(workloads.getDeploymentReplicaSets('gone', 'team-a')).resolves.toEqual([]);
        await expect(workloads.getDeploymentRollouts('gone', 'team-a')).resolves.toEqual([]);
    });

    it('lists and gets statefulsets and daemonsets through the same paths', async () => {
        await expect(workloads.listStatefulSets()).resolves.toEqual([]);
        expect(apps.listNamespacedStatefulSet).toHaveBeenCalledWith({ namespace: 'team-a' });
        await expect(workloads.getStatefulSet('db', 'team-a')).resolves.toMatchObject({ name: 'db' });
        await expect(workloads.listDaemonSets('kube-system')).resolves.toEqual([]);
        await expect(workloads.getDaemonSet('gone', 'team-a')).resolves.toBeNull();
        client.getActiveNamespace.mockReturnValue(null);
        await workloads.listDaemonSets();
        expect(apps.listDaemonSetForAllNamespaces).toHaveBeenCalled();
    });

    it('lists and gets replica sets and replication controllers', async () => {
        apps.listReplicaSetForAllNamespaces.mockResolvedValue({ items: [replicaSet('1')] });
        apps.readNamespacedReplicaSet.mockResolvedValue(replicaSet('1'));
        core.listNamespacedReplicationController.mockResolvedValue({ items: [{ metadata: { name: 'legacy' } }] });
        core.listReplicationControllerForAllNamespaces.mockResolvedValue({ items: [] });
        core.readNamespacedReplicationController.mockResolvedValue({ metadata: { name: 'legacy' } });

        await expect(workloads.listReplicaSets('team-a')).resolves.toHaveLength(2);
        expect(apps.listNamespacedReplicaSet).toHaveBeenCalledWith({ namespace: 'team-a' });
        await expect(workloads.getReplicaSet('web-1', 'team-a')).resolves.toMatchObject({ owner: 'Deployment/web' });
        await expect(workloads.listReplicationControllers('team-a')).resolves.toMatchObject([{ name: 'legacy' }]);
        await expect(workloads.getReplicationController('legacy', 'team-a')).resolves.toMatchObject({
            name: 'legacy',
        });

        client.getActiveNamespace.mockReturnValue(null);
        await expect(workloads.listReplicaSets()).resolves.toHaveLength(1);
        expect(apps.listReplicaSetForAllNamespaces).toHaveBeenCalled();
        await expect(workloads.listReplicationControllers()).resolves.toEqual([]);
        expect(core.listReplicationControllerForAllNamespaces).toHaveBeenCalled();
        // A single object still refuses to guess a namespace.
        await expect(workloads.getReplicaSet('web-1')).resolves.toBeNull();
        await expect(workloads.getReplicationController('legacy')).resolves.toBeNull();
    });

    it('answers not found for a single object when no namespace is known, without searching the cluster', async () => {
        client.getActiveNamespace.mockReturnValue(null);
        apps.listStatefulSetForAllNamespaces.mockResolvedValue({
            items: [{ metadata: { name: 'db', namespace: 'x' } }],
        });
        await expect(workloads.getDeployment('web')).resolves.toBeNull();
        await expect(workloads.getStatefulSet('db')).resolves.toBeNull();
        await expect(workloads.getDaemonSet('agent')).resolves.toBeNull();
        expect(apps.listDeploymentForAllNamespaces).not.toHaveBeenCalled();
        expect(apps.readNamespacedDeployment).not.toHaveBeenCalled();
        // Lists still span the cluster; only the single-object reads refuse to guess.
        await expect(workloads.listStatefulSets()).resolves.toHaveLength(1);
        expect(apps.listStatefulSetForAllNamespaces).toHaveBeenCalledTimes(1);
    });

    it('returns no replicasets for a deployment without a namespace', async () => {
        apps.readNamespacedDeployment.mockResolvedValue(deployment({ metadata: { name: 'web', uid: 'dep-1' } }));
        await expect(workloads.getDeploymentReplicaSets('web', 'team-a')).resolves.toEqual([]);
        expect(apps.listNamespacedReplicaSet).not.toHaveBeenCalled();
    });

    it('compares two revisions as identically formatted templates', async () => {
        const { compareDeploymentRevisions } = workloads;
        apps.listNamespacedReplicaSet.mockResolvedValue({
            items: [
                replicaSet('1', {
                    spec: { template: { spec: { containers: [{ name: 'web', image: 'nginx:1.0' }] } } },
                }),
                replicaSet('2', {
                    spec: { template: { spec: { containers: [{ name: 'web', image: 'nginx:2.0' }] } } },
                }),
            ],
        });
        const comparison = await compareDeploymentRevisions({
            name: 'web',
            namespace: 'team-a',
            from: '1',
            to: '2',
        });
        expect(comparison.from.rev).toBe('1');
        expect(comparison.from.yaml).toContain('nginx:1.0');
        expect(comparison.to.yaml).toContain('nginx:2.0');
        // Both sides go through the same canonicalisation, so the only textual difference is real.
        expect(comparison.from.yaml.split('\n').length).toBe(comparison.to.yaml.split('\n').length);
    });

    it('says which revision is gone rather than showing an empty pane', async () => {
        const { compareDeploymentRevisions } = workloads;
        await expect(
            compareDeploymentRevisions({ name: 'web', namespace: 'team-a', from: '1', to: '9' }),
        ).rejects.toMatchObject({ kind: 'notFound', op: 'deployments.compare' });
        apps.readNamespacedDeployment.mockResolvedValue(undefined);
        await expect(
            compareDeploymentRevisions({ name: 'gone', namespace: 'team-a', from: '1', to: '2' }),
        ).rejects.toMatchObject({ kind: 'notFound' });
    });

    it('classifies failures under the channel ops', async () => {
        apps.listNamespacedDeployment.mockRejectedValue(new ApiException(403, 'x', { message: 'denied' }, {}));
        await expect(workloads.listDeployments()).rejects.toMatchObject({ kind: 'forbidden', op: 'resources.list' });
        apps.listNamespacedReplicaSet.mockRejectedValue(new Error('boom'));
        await expect(workloads.getDeploymentRollouts('web', 'team-a')).rejects.toMatchObject({
            op: 'deployments.rollouts',
        });
    });
});

const job = (overrides: Partial<V1Job> = {}): V1Job =>
    ({
        metadata: {
            name: 'import',
            namespace: 'team-a',
            creationTimestamp: new Date(NOW - HOUR),
            labels: { app: 'x' },
        },
        spec: { completions: 3 },
        status: {
            succeeded: 3,
            startTime: new Date(NOW - 2 * HOUR),
            completionTime: new Date(NOW - HOUR),
            conditions: [{ type: 'Complete', status: 'True' }],
        },
        ...overrides,
    }) as V1Job;

describe('job transforms', () => {
    it('reads the status from terminal conditions, defaulting to Running', () => {
        expect(workloads.jobStatus(job())).toBe('Complete');
        expect(workloads.jobStatus(job({ status: { conditions: [{ type: 'Failed', status: 'True' }] } }))).toBe(
            'Failed',
        );
        // Failed outranks Complete when both are set.
        expect(
            workloads.jobStatus(
                job({
                    status: {
                        conditions: [
                            { type: 'Complete', status: 'True' },
                            { type: 'Failed', status: 'True' },
                        ],
                    },
                }),
            ),
        ).toBe('Failed');
        expect(workloads.jobStatus(job({ status: { conditions: [{ type: 'Complete', status: 'False' }] } }))).toBe(
            'Running',
        );
        expect(workloads.jobStatus(job({ status: {} }))).toBe('Running');
    });

    it('reads a suspended job as Suspended, below its terminal conditions', () => {
        expect(workloads.jobStatus(job({ spec: { suspend: true, template: {} }, status: {} }))).toBe('Suspended');
        expect(workloads.jobStatus(job({ status: { conditions: [{ type: 'Suspended', status: 'True' }] } }))).toBe(
            'Suspended',
        );
        expect(workloads.jobStatus(job({ status: { conditions: [{ type: 'Suspended', status: 'False' }] } }))).toBe(
            'Running',
        );
        expect(
            workloads.jobStatus(
                job({
                    spec: { suspend: true, template: {} },
                    status: { conditions: [{ type: 'Failed', status: 'True' }] },
                }),
            ),
        ).toBe('Failed');
    });

    it('builds the row with completions, duration and age', () => {
        expect(workloads.toJob(job(), NOW)).toEqual({
            name: 'import',
            namespace: 'team-a',
            completions: '3/3',
            duration: '1h0m',
            status: 'Complete',
            age: '1h',
        });
        // A running job measures against now; one that never started has no duration.
        expect(workloads.toJob(job({ spec: {}, status: { startTime: new Date(NOW - 60_000) } }), NOW)).toMatchObject({
            completions: '0/1',
            duration: '1m0s',
            status: 'Running',
        });
        expect(workloads.toJob(job({ spec: {}, status: {} }), NOW).duration).toBe('—');
    });

    it('carries label pairs on the detail', () => {
        expect(workloads.toJobDetail(job(), NOW)).toMatchObject({ labels: [['app', 'x']], annotations: [] });
    });
});

const cronJob = (overrides: Partial<V1CronJob> = {}): V1CronJob =>
    ({
        metadata: { name: 'nightly', namespace: 'team-a', creationTimestamp: new Date(NOW - 3 * 24 * HOUR) },
        spec: { schedule: '0 2 * * *', suspend: false },
        status: { active: [{ name: 'nightly-1' }], lastScheduleTime: new Date(NOW - 2 * HOUR) },
        ...overrides,
    }) as V1CronJob;

describe('cronjob transforms', () => {
    it('builds the row with schedule, suspend, active count and last schedule', () => {
        expect(workloads.toCronJob(cronJob(), NOW)).toEqual({
            name: 'nightly',
            namespace: 'team-a',
            schedule: '0 2 * * *',
            suspend: false,
            active: 1,
            lastSchedule: '2h ago',
            age: '3d',
        });
    });

    it('defaults a sparse cron job to not suspended, no active jobs and dashes', () => {
        expect(workloads.toCronJob({ metadata: { name: 'x' } }, NOW)).toMatchObject({
            schedule: '—',
            suspend: false,
            active: 0,
            lastSchedule: '—',
        });
        expect(workloads.toCronJob(cronJob({ spec: { schedule: '@daily', suspend: true } }), NOW).suspend).toBe(true);
    });
});

const autoscaler = (overrides: Partial<V2HorizontalPodAutoscaler> = {}): V2HorizontalPodAutoscaler =>
    ({
        metadata: { name: 'web', namespace: 'team-a', creationTimestamp: new Date(NOW - HOUR) },
        spec: {
            scaleTargetRef: { kind: 'Deployment', name: 'web' },
            minReplicas: 2,
            maxReplicas: 10,
            metrics: [
                {
                    type: 'Resource',
                    resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 80 } },
                },
            ],
        },
        status: {
            currentReplicas: 3,
            currentMetrics: [{ type: 'Resource', resource: { name: 'cpu', current: { averageUtilization: 42 } } }],
        },
        ...overrides,
    }) as V2HorizontalPodAutoscaler;

describe('autoscaler transforms', () => {
    it('formats the target utilisation pair, falling back to zero on one side', () => {
        expect(workloads.hpaTargets(autoscaler())).toBe('42% / 80%');
        expect(workloads.hpaTargets(autoscaler({ status: { currentReplicas: 1 } }))).toBe('0% / 80%');
        expect(workloads.hpaTargets(autoscaler({ spec: { maxReplicas: 3 }, status: { currentReplicas: 1 } }))).toBe(
            '—',
        );
    });

    it('builds the row with the scale reference and replica bounds', () => {
        expect(workloads.toAutoscaler(autoscaler(), NOW)).toEqual({
            name: 'web',
            namespace: 'team-a',
            reference: 'Deployment/web',
            min: 2,
            max: 10,
            replicas: 3,
            targets: '42% / 80%',
            targetCpuPercent: 80,
            age: '1h',
        });
        expect(workloads.toAutoscaler({ metadata: { name: 'x' }, spec: { maxReplicas: 5 } }, NOW)).toMatchObject({
            reference: '—',
            min: 1,
            max: 5,
            replicas: 0,
            targets: '—',
        });
    });
});

describe('batch and autoscaler readers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        client.getActiveNamespace.mockReturnValue('team-a');
        batch.listNamespacedJob.mockResolvedValue({ items: [job()] });
        batch.listJobForAllNamespaces.mockResolvedValue({
            items: [job(), job({ metadata: { name: 'other', namespace: 'b' } })],
        });
        batch.readNamespacedJob.mockResolvedValue(job());
        batch.listNamespacedCronJob.mockResolvedValue({ items: [cronJob()] });
        batch.listCronJobForAllNamespaces.mockResolvedValue({ items: [] });
        batch.readNamespacedCronJob.mockRejectedValue(new ApiException(404, 'x', null, {}));
        hpa.listNamespacedHorizontalPodAutoscaler.mockResolvedValue({ items: [autoscaler()] });
        hpa.listHorizontalPodAutoscalerForAllNamespaces.mockResolvedValue({ items: [] });
        hpa.readNamespacedHorizontalPodAutoscaler.mockResolvedValue(autoscaler());
    });

    it('lists and gets jobs in the explicit, active or all namespaces', async () => {
        expect((await workloads.listJobs('explicit')).map((j) => j.name)).toEqual(['import']);
        expect(batch.listNamespacedJob).toHaveBeenCalledWith({ namespace: 'explicit' });
        await expect(workloads.getJob('import', 'team-a')).resolves.toMatchObject({
            name: 'import',
            labels: [['app', 'x']],
        });
        client.getActiveNamespace.mockReturnValue(null);
        expect((await workloads.listJobs()).map((j) => j.namespace)).toEqual(['team-a', 'b']);
    });

    it('lists and gets cron jobs, returning null for a missing one', async () => {
        expect((await workloads.listCronJobs()).map((c) => c.name)).toEqual(['nightly']);
        expect(batch.listNamespacedCronJob).toHaveBeenCalledWith({ namespace: 'team-a' });
        await expect(workloads.getCronJob('gone', 'team-a')).resolves.toBeNull();
    });

    it('lists and gets autoscalers', async () => {
        expect((await workloads.listAutoscalers()).map((a) => a.reference)).toEqual(['Deployment/web']);
        await expect(workloads.getAutoscaler('web', 'team-a')).resolves.toMatchObject({ name: 'web', annotations: [] });
        client.getActiveNamespace.mockReturnValue(null);
        await workloads.listAutoscalers();
        expect(hpa.listHorizontalPodAutoscalerForAllNamespaces).toHaveBeenCalled();
    });

    it('classifies failures under the generic ops', async () => {
        batch.listNamespacedJob.mockRejectedValue(new ApiException(403, 'x', { message: 'denied' }, {}));
        await expect(workloads.listJobs()).rejects.toMatchObject({ kind: 'forbidden', op: 'resources.list' });
        hpa.readNamespacedHorizontalPodAutoscaler.mockRejectedValue(
            Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
        );
        await expect(workloads.getAutoscaler('web', 'team-a')).rejects.toMatchObject({
            kind: 'unreachable',
            op: 'resources.get',
        });
    });
});
