import type { NodeMetricsList, PodMetricsList } from '@kubernetes/client-node';
import type { Usage } from '../../shared/k8s/metrics.js';
import { clusterGet } from './cluster-get.js';
import { cpuToMillicores, memToMi } from './format.js';

/**
 * Pod usage from metrics.k8s.io keyed by `namespace/name`. metrics-server is optional: when the API
 * group is absent or unreachable the map is empty and lists still render with zero usage.
 */
const OP = 'metrics';

/**
 * The library's `Metrics` class sends with a `fetch` of its own and takes no signal, so a read that
 * never answers would outlive every ceiling. `clusterGet` puts the current call's signal on the
 * request, and a 404 (no metrics-server) comes back as null.
 */
async function metricsGet<T extends PodMetricsList | NodeMetricsList>(path: string): Promise<T['items']> {
    const list = (await clusterGet(`/apis/metrics.k8s.io/v1beta1/${path}`, OP)) as T | null;
    return list?.items ?? [];
}

export async function readPodUsage(): Promise<Map<string, Usage>> {
    return (await readUsage()).pods;
}

/** The key one container's usage is filed under: its pod, then its own name. */
export const containerUsageKey = (namespace: string, pod: string, container: string): string =>
    `${namespace}/${pod}/${container}`;

/**
 * One read of metrics.k8s.io, kept at both levels it is useful at: the pod totals every list shows,
 * and the per-container figures the container rows put beside their requests. The API reports only
 * containers, so the pod total is their sum; reading it once keeps the two consistent by
 * construction rather than by two calls that might see different moments.
 */
export async function readUsage(): Promise<{ pods: Map<string, Usage>; containers: Map<string, Usage> }> {
    const pods = new Map<string, Usage>();
    const containers = new Map<string, Usage>();
    try {
        for (const item of await metricsGet<PodMetricsList>('pods')) {
            // One item missing `containers` or `usage` must not truncate the map mid-loop.
            const inPod = item.containers ?? [];
            const namespace = item.metadata.namespace;
            const name = item.metadata.name;
            for (const container of inPod) {
                containers.set(containerUsageKey(namespace, name, container.name), {
                    cpu: cpuToMillicores(container.usage?.cpu),
                    mem: memToMi(container.usage?.memory),
                });
            }
            pods.set(`${namespace}/${name}`, {
                cpu: inPod.reduce((sum, c) => sum + cpuToMillicores(c.usage?.cpu), 0),
                mem: inPod.reduce((sum, c) => sum + memToMi(c.usage?.memory), 0),
            });
        }
    } catch {
        // metrics-server absent or unreachable: graceful empty.
    }
    return { pods, containers };
}

/** Node usage from metrics.k8s.io keyed by node name; empty when metrics-server is unavailable. */
export async function readNodeUsage(): Promise<Map<string, Usage>> {
    const out = new Map<string, Usage>();
    try {
        for (const item of await metricsGet<NodeMetricsList>('nodes')) {
            out.set(item.metadata.name, { cpu: cpuToMillicores(item.usage?.cpu), mem: memToMi(item.usage?.memory) });
        }
    } catch {
        // graceful empty.
    }
    return out;
}
