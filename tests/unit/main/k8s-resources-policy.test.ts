import { ApiException, type V1Lease, type V1PodDisruptionBudget, type V1PriorityClass } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const policyApi = {
    listNamespacedPodDisruptionBudget: vi.fn(),
    listPodDisruptionBudgetForAllNamespaces: vi.fn(),
    readNamespacedPodDisruptionBudget: vi.fn(),
};
const scheduling = { listPriorityClass: vi.fn(), readPriorityClass: vi.fn() };
const coordination = {
    listNamespacedLease: vi.fn(),
    listLeaseForAllNamespaces: vi.fn(),
    readNamespacedLease: vi.fn(),
};
const client = {
    apis: () => ({ policy: policyApi, scheduling, coordination }),
    getActiveNamespace: vi.fn<() => string | null>(),
    resolveObjectNamespace: (explicit?: string) => explicit ?? client.getActiveNamespace(),
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

const policy = await import('../../../src/main/k8s/resources/policy.js');

const NOW = Date.parse('2026-09-16T12:00:00Z');
const HOUR = 3600 * 1000;

describe('disruption budget transforms', () => {
    const budget: V1PodDisruptionBudget = {
        metadata: {
            name: 'web',
            namespace: 'team-a',
            creationTimestamp: new Date(NOW - 2 * HOUR),
            labels: { app: 'web' },
            annotations: { owner: 'platform' },
        },
        spec: { minAvailable: 2, selector: { matchLabels: { app: 'web' } } },
        status: {
            currentHealthy: 3,
            desiredHealthy: 2,
            disruptionsAllowed: 1,
            expectedPods: 3,
            disruptedPods: {},
            observedGeneration: 1,
            conditions: [],
        },
    };

    it('reads the counts, the promise as written and the selector', () => {
        expect(policy.toPodDisruptionBudget(budget, NOW)).toEqual({
            name: 'web',
            namespace: 'team-a',
            status: 'Satisfied',
            policy: 'min available 2',
            currentHealthy: 3,
            desiredHealthy: 2,
            disruptionsAllowed: 1,
            selector: 'app=web',
            age: '2h',
        });
    });

    it('is Blocked when it allows no disruption at all', () => {
        const blocked = { ...budget, status: { ...budget.status!, disruptionsAllowed: 0 } };
        expect(policy.toPodDisruptionBudget(blocked, NOW).status).toBe('Blocked');
        // A budget the API has not reported on yet reads as blocked rather than as permission.
        expect(policy.toPodDisruptionBudget({ metadata: { name: 'x' } }, NOW)).toMatchObject({
            status: 'Blocked',
            disruptionsAllowed: 0,
            namespace: '',
        });
    });

    it('reports maxUnavailable, a percentage and a budget with neither', () => {
        expect(policy.budgetPolicy({ spec: { maxUnavailable: '25%' } })).toBe('max unavailable 25%');
        expect(policy.budgetPolicy({ spec: { minAvailable: '50%' } })).toBe('min available 50%');
        expect(policy.budgetPolicy({})).toBe('—');
    });

    it('tells a selector matching every pod from one matching none, and names expressions', () => {
        expect(policy.toPodDisruptionBudget({ ...budget, spec: { selector: {} } }, NOW).selector).toBe('<all pods>');
        // In policy/v1 a budget with no selector at all selects no pods.
        expect(policy.toPodDisruptionBudget({ ...budget, spec: {} }, NOW).selector).toBe('—');
        const expressions = {
            ...budget,
            spec: { selector: { matchExpressions: [{ key: 'app', operator: 'In', values: ['web', 'api'] }] } },
        };
        expect(policy.toPodDisruptionBudget(expressions, NOW).selector).toBe('app in (web,api)');
    });

    it('adds labels and annotations to the detail', () => {
        expect(policy.toPodDisruptionBudgetDetail(budget, NOW)).toMatchObject({
            labels: [['app', 'web']],
            annotations: [['owner', 'platform']],
        });
    });
});

describe('priority class transforms', () => {
    const priorityClass: V1PriorityClass = {
        metadata: { name: 'system-critical', creationTimestamp: new Date(NOW - HOUR), labels: { tier: 'system' } },
        value: 2_000_000,
        globalDefault: true,
        preemptionPolicy: 'Never',
        description: 'Never evicted.',
    };

    it('reads the value, the default flag and the preemption policy', () => {
        expect(policy.toPriorityClass(priorityClass, NOW)).toEqual({
            name: 'system-critical',
            value: 2_000_000,
            globalDefault: true,
            preemption: 'Never',
            description: 'Never evicted.',
            age: '1h',
        });
    });

    it('spells out the preemption the API leaves unset, and dashes a missing description', () => {
        expect(policy.toPriorityClass({ metadata: { name: 'low' }, value: -10 }, NOW)).toEqual({
            name: 'low',
            value: -10,
            globalDefault: false,
            preemption: 'PreemptLowerPriority',
            description: '—',
            age: '—',
        });
    });

    it('adds labels and annotations to the detail', () => {
        expect(policy.toPriorityClassDetail(priorityClass, NOW)).toMatchObject({
            labels: [['tier', 'system']],
            annotations: [],
        });
    });
});

describe('lease transforms', () => {
    const lease: V1Lease = {
        metadata: { name: 'kube-scheduler', namespace: 'kube-system', creationTimestamp: new Date(NOW - HOUR) },
        spec: { holderIdentity: 'node-1_8f2', leaseDurationSeconds: 15, renewTime: new Date(NOW - 60_000) },
    };

    it('reads the holder, the duration and how long ago it was renewed', () => {
        expect(policy.toLease(lease, NOW)).toEqual({
            name: 'kube-scheduler',
            namespace: 'kube-system',
            holder: 'node-1_8f2',
            duration: '15s',
            renewed: '1m ago',
            age: '1h',
        });
    });

    it('dashes an unheld lease with no duration and no renewal', () => {
        expect(policy.toLease({ metadata: { name: 'idle', namespace: 'kube-node-lease' }, spec: {} }, NOW)).toEqual({
            name: 'idle',
            namespace: 'kube-node-lease',
            holder: '—',
            duration: '—',
            renewed: '—',
            age: '—',
        });
    });

    it('adds labels and annotations to the detail', () => {
        expect(policy.toLeaseDetail(lease, NOW)).toMatchObject({ labels: [], annotations: [] });
    });
});

describe('policy readers', () => {
    beforeEach(() => {
        for (const api of [policyApi, scheduling, coordination]) {
            for (const fn of Object.values(api)) fn.mockReset();
        }
        client.getActiveNamespace.mockReturnValue('team-a');
    });

    it('lists budgets and leases in the active namespace, and across the cluster with none', async () => {
        policyApi.listNamespacedPodDisruptionBudget.mockResolvedValue({ items: [{ metadata: { name: 'web' } }] });
        policyApi.listPodDisruptionBudgetForAllNamespaces.mockResolvedValue({ items: [] });
        coordination.listNamespacedLease.mockResolvedValue({ items: [{ metadata: { name: 'l' } }] });
        coordination.listLeaseForAllNamespaces.mockResolvedValue({ items: [] });

        await expect(policy.listPodDisruptionBudgets()).resolves.toMatchObject([{ name: 'web' }]);
        expect(policyApi.listNamespacedPodDisruptionBudget).toHaveBeenCalledWith({ namespace: 'team-a' });
        await expect(policy.listLeases('kube-system')).resolves.toMatchObject([{ name: 'l' }]);
        expect(coordination.listNamespacedLease).toHaveBeenCalledWith({ namespace: 'kube-system' });

        client.getActiveNamespace.mockReturnValue(null);
        await expect(policy.listPodDisruptionBudgets()).resolves.toEqual([]);
        expect(policyApi.listPodDisruptionBudgetForAllNamespaces).toHaveBeenCalled();
        await expect(policy.listLeases()).resolves.toEqual([]);
        expect(coordination.listLeaseForAllNamespaces).toHaveBeenCalled();
    });

    it('lists priority classes cluster-wide, ignoring the active namespace', async () => {
        scheduling.listPriorityClass.mockResolvedValue({ items: [{ metadata: { name: 'high' }, value: 10 }] });
        await expect(policy.listPriorityClasses()).resolves.toMatchObject([{ name: 'high', value: 10 }]);
        expect(scheduling.listPriorityClass).toHaveBeenCalledWith();
    });

    it('reads one of each kind', async () => {
        policyApi.readNamespacedPodDisruptionBudget.mockResolvedValue({ metadata: { name: 'web' } });
        scheduling.readPriorityClass.mockResolvedValue({ metadata: { name: 'high' }, value: 10 });
        coordination.readNamespacedLease.mockResolvedValue({ metadata: { name: 'l' }, spec: {} });

        await expect(policy.getPodDisruptionBudget('web', 'team-a')).resolves.toMatchObject({ name: 'web' });
        expect(policyApi.readNamespacedPodDisruptionBudget).toHaveBeenCalledWith({ name: 'web', namespace: 'team-a' });
        await expect(policy.getPriorityClass('high')).resolves.toMatchObject({ name: 'high', value: 10 });
        await expect(policy.getLease('l', 'kube-system')).resolves.toMatchObject({ name: 'l' });
    });

    it('answers null for a missing object and for a namespaced read with no namespace known', async () => {
        const gone = new ApiException(404, 'not found', {}, {});
        policyApi.readNamespacedPodDisruptionBudget.mockRejectedValue(gone);
        scheduling.readPriorityClass.mockRejectedValue(gone);
        coordination.readNamespacedLease.mockRejectedValue(gone);
        await expect(policy.getPodDisruptionBudget('web', 'team-a')).resolves.toBeNull();
        await expect(policy.getPriorityClass('high')).resolves.toBeNull();

        client.getActiveNamespace.mockReturnValue(null);
        await expect(policy.getLease('l')).resolves.toBeNull();
        expect(coordination.readNamespacedLease).not.toHaveBeenCalled();
    });
});
