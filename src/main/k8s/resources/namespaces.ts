import type { V1Namespace, V1Pod } from '@kubernetes/client-node';
import type { NamespaceCount, NamespaceDetail, NamespacePhase } from '../../../shared/k8s/namespaces.js';
import { KIND_REGISTRY } from '../../../shared/k8s/registry.js';
import { apis, readOrNull } from '../client.js';
import { withK8s } from '../errors.js';
import { podUsage } from '../sampler.js';
import { age, cpuToMillicores, memToMi, toPairs } from '../format.js';
import { toResourceQuotaRows } from './overview.js';
import { toLimitRangeRows } from './overview.js';

/*
 * A namespace as a screen of its own. A namespace does nothing by itself: it is the boundary
 * everything else is counted inside, so its detail is a roll-up of what lives here, what it is
 * allowed and what it currently uses.
 */

/** Terminating is the state worth seeing: the namespace accepts no new object and is going away. */
export function namespacePhase(ns: V1Namespace): NamespacePhase {
    return ns.status?.phase === 'Terminating' ? 'Terminating' : 'Active';
}

/**
 * What a namespace's pods asked for, summed, which is what its usage should be read against. A pod
 * that has finished holds nothing any more, so the scheduler and quotas no longer count it.
 */
export function podRequests(pods: V1Pod[]): { cpu: number; mem: number } {
    let cpu = 0;
    let mem = 0;
    for (const pod of pods) {
        if (pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed') continue;
        for (const container of pod.spec?.containers ?? []) {
            cpu += cpuToMillicores(container.resources?.requests?.cpu);
            mem += memToMi(container.resources?.requests?.memory);
        }
    }
    return { cpu, mem };
}

/** Usage summed over the namespace's pods, from the sampler's latest read rather than a fresh one. */
export function podUsageTotal(pods: V1Pod[]): { cpu: number; mem: number } {
    let cpu = 0;
    let mem = 0;
    for (const pod of pods) {
        const usage = podUsage(pod.metadata?.namespace ?? '', pod.metadata?.name ?? '');
        cpu += usage?.cpu ?? 0;
        mem += usage?.mem ?? 0;
    }
    return { cpu, mem };
}

const countOf = (kind: keyof typeof KIND_REGISTRY, count: number): NamespaceCount => ({
    kind: KIND_REGISTRY[kind].kind,
    count,
    listPath: KIND_REGISTRY[kind].listPath,
});

/**
 * The kinds worth counting on a namespace screen: what people mean when they ask what is in here.
 * Each count links to that kind's list rather than only stating a number.
 */
export function getNamespaceDetail(name: string): Promise<NamespaceDetail | null> {
    return withK8s('namespaces.detail', async () => {
        const ns = await readOrNull(() => apis().core.readNamespace({ name }));
        if (!ns) return null;

        const [pods, deployments, statefulSets, daemonSets, services, configMaps, secrets, claims, quotas, limits] =
            await Promise.all([
                apis().core.listNamespacedPod({ namespace: name }),
                apis().apps.listNamespacedDeployment({ namespace: name }),
                apis().apps.listNamespacedStatefulSet({ namespace: name }),
                apis().apps.listNamespacedDaemonSet({ namespace: name }),
                apis().core.listNamespacedService({ namespace: name }),
                apis().core.listNamespacedConfigMap({ namespace: name }),
                apis().core.listNamespacedSecret({ namespace: name }),
                apis().core.listNamespacedPersistentVolumeClaim({ namespace: name }),
                apis().core.listNamespacedResourceQuota({ namespace: name }),
                apis().core.listNamespacedLimitRange({ namespace: name }),
            ]);

        const usage = podUsageTotal(pods.items);
        const requested = podRequests(pods.items);
        return {
            name,
            phase: namespacePhase(ns),
            age: age(ns.metadata?.creationTimestamp),
            labels: toPairs(ns.metadata?.labels),
            annotations: toPairs(ns.metadata?.annotations),
            counts: [
                countOf('Pod', pods.items.length),
                countOf('Deployment', deployments.items.length),
                countOf('StatefulSet', statefulSets.items.length),
                countOf('DaemonSet', daemonSets.items.length),
                countOf('Service', services.items.length),
                countOf('ConfigMap', configMaps.items.length),
                countOf('Secret', secrets.items.length),
                countOf('PersistentVolumeClaim', claims.items.length),
            ],
            quotas: quotas.items.flatMap((quota) => toResourceQuotaRows(quota)),
            limits: limits.items.flatMap((limitRange) => toLimitRangeRows(limitRange)),
            cpuUsed: usage.cpu,
            memUsed: usage.mem,
            cpuRequested: requested.cpu,
            memRequested: requested.mem,
        };
    });
}
