import type { V1Lease, V1PodDisruptionBudget, V1PriorityClass } from '@kubernetes/client-node';
import type {
    DisruptionStatus,
    Lease,
    LeaseDetail,
    PodDisruptionBudget,
    PodDisruptionBudgetDetail,
    PriorityClass,
    PriorityClassDetail,
} from '../../../shared/k8s/policy.js';
import { apis, getNamespaced, listItems, readOrNull } from '../client.js';
import { withK8s } from '../errors.js';
import { age, ago, dash, formatLabelSelector, toPairs } from '../format.js';

/*
 * The kinds that decide what the control plane may disturb: budgets that hold evictions back,
 * priority classes that order the scheduler, and leases that say who currently leads.
 */

/**
 * A budget is Blocked when it allows no disruption at all. That is the state worth seeing: a drain
 * or an upgrade stops on it, and nothing in the counts alone says so.
 */
export function disruptionStatus(disruptionsAllowed: number): DisruptionStatus {
    return disruptionsAllowed > 0 ? 'Satisfied' : 'Blocked';
}

/** The promise the budget was written with, in its own words rather than a derived number. */
export function budgetPolicy(pdb: V1PodDisruptionBudget): string {
    const { minAvailable, maxUnavailable } = pdb.spec ?? {};
    if (minAvailable !== undefined && minAvailable !== null) return `min available ${minAvailable}`;
    if (maxUnavailable !== undefined && maxUnavailable !== null) return `max unavailable ${maxUnavailable}`;
    return '—';
}

export function toPodDisruptionBudget(pdb: V1PodDisruptionBudget, now = Date.now()): PodDisruptionBudget {
    const disruptionsAllowed = pdb.status?.disruptionsAllowed ?? 0;
    return {
        name: pdb.metadata?.name ?? '',
        namespace: pdb.metadata?.namespace ?? '',
        status: disruptionStatus(disruptionsAllowed),
        policy: budgetPolicy(pdb),
        currentHealthy: pdb.status?.currentHealthy ?? 0,
        desiredHealthy: pdb.status?.desiredHealthy ?? 0,
        disruptionsAllowed,
        // In policy/v1 an empty selector covers every pod in the namespace and an absent one none.
        selector: formatLabelSelector(pdb.spec?.selector, { everything: '<all pods>', nothing: '—' }),
        age: age(pdb.metadata?.creationTimestamp, now),
    };
}

export function toPodDisruptionBudgetDetail(pdb: V1PodDisruptionBudget, now = Date.now()): PodDisruptionBudgetDetail {
    return {
        ...toPodDisruptionBudget(pdb, now),
        labels: toPairs(pdb.metadata?.labels),
        annotations: toPairs(pdb.metadata?.annotations),
    };
}

export function toPriorityClass(priorityClass: V1PriorityClass, now = Date.now()): PriorityClass {
    return {
        name: priorityClass.metadata?.name ?? '',
        value: priorityClass.value ?? 0,
        globalDefault: priorityClass.globalDefault === true,
        // Unset means PreemptLowerPriority; the API omits the default rather than writing it out.
        preemption: priorityClass.preemptionPolicy ?? 'PreemptLowerPriority',
        description: dash(priorityClass.description),
        age: age(priorityClass.metadata?.creationTimestamp, now),
    };
}

export function toPriorityClassDetail(priorityClass: V1PriorityClass, now = Date.now()): PriorityClassDetail {
    return {
        ...toPriorityClass(priorityClass, now),
        labels: toPairs(priorityClass.metadata?.labels),
        annotations: toPairs(priorityClass.metadata?.annotations),
    };
}

export function toLease(lease: V1Lease, now = Date.now()): Lease {
    const seconds = lease.spec?.leaseDurationSeconds;
    return {
        name: lease.metadata?.name ?? '',
        namespace: lease.metadata?.namespace ?? '',
        holder: dash(lease.spec?.holderIdentity),
        duration: seconds === undefined || seconds === null ? '—' : `${seconds}s`,
        renewed: ago(lease.spec?.renewTime, now),
        age: age(lease.metadata?.creationTimestamp, now),
    };
}

export function toLeaseDetail(lease: V1Lease, now = Date.now()): LeaseDetail {
    return {
        ...toLease(lease, now),
        labels: toPairs(lease.metadata?.labels),
        annotations: toPairs(lease.metadata?.annotations),
    };
}

export function listPodDisruptionBudgets(namespace?: string): Promise<PodDisruptionBudget[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().policy.listNamespacedPodDisruptionBudget({ namespace: ns }),
            () => apis().policy.listPodDisruptionBudgetForAllNamespaces(),
        );
        return items.map((pdb) => toPodDisruptionBudget(pdb));
    });
}

export function getPodDisruptionBudget(name: string, namespace?: string): Promise<PodDisruptionBudgetDetail | null> {
    return withK8s('resources.get', async () => {
        const pdb = await getNamespaced(name, namespace, (n, ns) =>
            apis().policy.readNamespacedPodDisruptionBudget({ name: n, namespace: ns }),
        );
        return pdb ? toPodDisruptionBudgetDetail(pdb) : null;
    });
}

export function listPriorityClasses(): Promise<PriorityClass[]> {
    return withK8s('resources.list', async () => {
        const { items } = await apis().scheduling.listPriorityClass();
        return items.map((priorityClass) => toPriorityClass(priorityClass));
    });
}

export function getPriorityClass(name: string): Promise<PriorityClassDetail | null> {
    return withK8s('resources.get', async () => {
        const priorityClass = await readOrNull(() => apis().scheduling.readPriorityClass({ name }));
        return priorityClass ? toPriorityClassDetail(priorityClass) : null;
    });
}

export function listLeases(namespace?: string): Promise<Lease[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().coordination.listNamespacedLease({ namespace: ns }),
            () => apis().coordination.listLeaseForAllNamespaces(),
        );
        return items.map((lease) => toLease(lease));
    });
}

export function getLease(name: string, namespace?: string): Promise<LeaseDetail | null> {
    return withK8s('resources.get', async () => {
        const lease = await getNamespaced(name, namespace, (n, ns) =>
            apis().coordination.readNamespacedLease({ name: n, namespace: ns }),
        );
        return lease ? toLeaseDetail(lease) : null;
    });
}
