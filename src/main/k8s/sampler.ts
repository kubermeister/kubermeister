import type { ClusterSparklines, HealthPoint, ResourceSeries, Usage } from '../../shared/k8s/metrics.js';
import { currentAbortSignal } from './abort.js';
import { apis } from './client.js';
import { withK8s } from './errors.js';
import { cpuToMillicores, memToMi } from './format.js';
import { containerUsageKey, readNodeUsage, readUsage } from './metrics.js';

/**
 * In-memory metrics sampler. metrics.k8s.io only reports instantaneous usage, so moving charts come
 * from polling on an interval and keeping bounded ring buffers here in the main process. Read-only:
 * it never writes to the cluster. Started lazily by the first read that needs usage; history is
 * discarded on context switch because the points belong to the previous cluster.
 */

export const SAMPLE_INTERVAL_MS = 12_000;
/** About 20 minutes of history at the sample interval. */
export const BUFFER_POINTS = 100;
/** Distinct pods whose series are kept, least recently requested evicted first. */
export const TRACKED_RESOURCES_CAP = 40;

interface AggregatePoint {
    t: number;
    nodes: number;
    cpuPct: number;
    memPct: number;
}

let running = false;
/**
 * Bumped by every reset. A sample that was reading when the context switched belongs to the cluster
 * that was left, so it compares the epoch it started in before writing anything.
 */
let epoch = 0;
let timer: NodeJS.Timeout | null = null;
let aggregate: AggregatePoint[] = [];
/** Node name to percent-of-allocatable points. */
const perNode = new Map<string, Usage[]>();
/** `namespace/name` to millicore and MiB points, in LRU order. */
const perResource = new Map<string, Usage[]>();
let latestPods = new Map<string, Usage>();
let latestContainers = new Map<string, Usage>();
let latestNodes = new Map<string, Usage>();

function pushTrim<T>(ring: T[], value: T): void {
    ring.push(value);
    if (ring.length > BUFFER_POINTS) ring.shift();
}

async function bestEffort<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
        return await fn();
    } catch {
        return fallback;
    }
}

export function percent(used: number, total: number): number {
    return total > 0 ? Math.round((used / total) * 100) : 0;
}

/** Take one sample: refresh the latest usage maps and append a point to every ring. */
export async function sampleOnce(now = Date.now()): Promise<void> {
    const startedIn = epoch;
    const [usage, nodeUsage, nodeList] = await Promise.all([
        readUsage(),
        readNodeUsage(),
        bestEffort(() => apis().core.listNode(), { items: [] }),
    ]);
    // An aborted read answers empty rather than failing, which would be recorded as a zero point.
    if (epoch !== startedIn || currentAbortSignal()?.aborted) return;
    const podUsage = usage.pods;
    latestPods = podUsage;
    latestContainers = usage.containers;
    latestNodes = nodeUsage;

    let usedCpu = 0;
    let allocCpu = 0;
    let usedMem = 0;
    let allocMem = 0;
    const liveNodes = new Set<string>();
    for (const node of nodeList.items) {
        const name = node.metadata?.name;
        if (!name) continue;
        liveNodes.add(name);
        const alloc = node.status?.allocatable ?? node.status?.capacity ?? {};
        const allocCpuMilli = cpuToMillicores(alloc.cpu);
        const allocMemMi = memToMi(alloc.memory);
        const usage = nodeUsage.get(name) ?? { cpu: 0, mem: 0 };
        usedCpu += usage.cpu;
        allocCpu += allocCpuMilli;
        usedMem += usage.mem;
        allocMem += allocMemMi;
        const ring = perNode.get(name) ?? [];
        pushTrim(ring, { cpu: percent(usage.cpu, allocCpuMilli), mem: percent(usage.mem, allocMemMi) });
        perNode.set(name, ring);
    }
    // Drop history for nodes that no longer exist.
    for (const name of perNode.keys()) if (!liveNodes.has(name)) perNode.delete(name);

    pushTrim(aggregate, {
        t: now,
        nodes: nodeList.items.length,
        cpuPct: percent(usedCpu, allocCpu),
        memPct: percent(usedMem, allocMem),
    });

    // Every tracked pod gets a point: its usage, or zero when metrics do not know it.
    for (const [key, ring] of perResource) pushTrim(ring, podUsage.get(key) ?? { cpu: 0, mem: 0 });
}

async function tick(): Promise<void> {
    try {
        // Under the read ceiling like every other call: a credential plugin waiting for a sign-in or a
        // server that never answers would otherwise hold the chain forever and freeze every chart.
        await withK8s('metrics', () => sampleOnce());
    } catch {
        // A rejected sample must not kill the timer chain; charts flatline one interval and recover.
    } finally {
        if (running) timer = setTimeout(() => void tick(), SAMPLE_INTERVAL_MS);
    }
}

/** Start sampling if not already running, taking the first sample immediately. */
export function ensureSampler(): void {
    if (running) return;
    running = true;
    void tick();
}

export function stopSampler(): void {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
}

/** Discard history and the latest usage after a context switch. */
export function resetHistory(): void {
    epoch++;
    aggregate = [];
    perNode.clear();
    perResource.clear();
    latestPods = new Map();
    latestContainers = new Map();
    latestNodes = new Map();
}

/** Latest usage of one container, or undefined until metrics-server has reported it. */
export function containerUsage(namespace: string, pod: string, container: string): Usage | undefined {
    return latestContainers.get(containerUsageKey(namespace, pod, container));
}

/** The most recent pod usage sample, for list and detail rows; undefined before the first sample. */
export function podUsage(namespace: string, name: string): Usage | undefined {
    return latestPods.get(`${namespace}/${name}`);
}

export function nodeUsage(name: string): Usage | undefined {
    return latestNodes.get(name);
}

export function clusterSparklines(): ClusterSparklines {
    return {
        nodes: aggregate.map((p) => p.nodes),
        cpu: aggregate.map((p) => p.cpuPct),
        mem: aggregate.map((p) => p.memPct),
    };
}

export function workloadHealth(): HealthPoint[] {
    return aggregate.map((p) => ({ t: p.t, cpu: p.cpuPct, mem: p.memPct }));
}

export function nodeSeries(name: string): ResourceSeries {
    const ring = perNode.get(name) ?? [];
    return { cpu: ring.map((p) => p.cpu), mem: ring.map((p) => p.mem) };
}

/** Register a pod for tracking (bumping it to most recent) and return the series collected so far. */
export function trackResourceSeries(namespace: string, name: string): ResourceSeries {
    const key = `${namespace}/${name}`;
    const existing = perResource.get(key);
    if (existing) {
        perResource.delete(key);
        perResource.set(key, existing);
        return { cpu: existing.map((p) => p.cpu), mem: existing.map((p) => p.mem) };
    }
    perResource.set(key, []);
    if (perResource.size > TRACKED_RESOURCES_CAP) {
        const oldest = perResource.keys().next().value;
        if (oldest !== undefined) perResource.delete(oldest);
    }
    return { cpu: [], mem: [] };
}
