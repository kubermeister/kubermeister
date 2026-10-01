import type { ElectronApplication } from '@playwright/test';
import { clusterKubectl } from './cluster';

/** As many points as the sampler keeps, so a chart is full from the first shot. */
const POINTS = 100;
/** The sampler's cadence, which spaces the points of the one chart that plots against time. */
const SAMPLE_INTERVAL_MS = 12_000;

/** A node's usage now, in percent of what it can allocate, as `kubectl top node` reports it. */
interface NodeUsage {
    name: string;
    cpuPct: number;
    memPct: number;
}

/** What the three series channels answer: the cluster aggregate and each node, in percent. */
interface ChartHistory {
    aggregate: { nodes: number; cpu: number; mem: number }[];
    nodes: Record<string, { cpu: number[]; mem: number[] }>;
}

function currentUsage(): NodeUsage[] {
    const rows = clusterKubectl(['top', 'node', '--no-headers']).trim().split('\n');
    return rows.map((row) => {
        const [name, , cpu, , mem] = row.trim().split(/\s+/);
        return { name: name!, cpuPct: Number.parseInt(cpu!, 10), memPct: Number.parseInt(mem!, 10) };
    });
}

const clamp = (value: number) => Math.min(99, Math.max(1, Math.round(value)));

/**
 * A series that ends where the cluster is now, so a chart agrees with the figure printed beside it.
 * It is the same every run, so a re-shot chart differs only where the cluster does: CPU moves the
 * way a service under uneven load does, memory barely moves, as it does once every pod has started.
 */
function seriesEndingAt(now: number, wave: (i: number) => number): number[] {
    const end = wave(POINTS - 1);
    return Array.from({ length: POINTS }, (_, i) => clamp(now + wave(i) - end));
}

const cpuWave = (i: number) => 6 * Math.sin(i / 7) + 3 * Math.sin(i / 2.3) + 2 * Math.sin(i / 1.3);
const memWave = (i: number) => 1.5 * Math.sin(i / 11);

export function demoHistory(nodes: NodeUsage[] = currentUsage()): ChartHistory {
    const perNode = Object.fromEntries(
        nodes.map((node) => [
            node.name,
            { cpu: seriesEndingAt(node.cpuPct, cpuWave), mem: seriesEndingAt(node.memPct, memWave) },
        ]),
    );
    const series = Object.values(perNode);
    const mean = (values: number[]) => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    return {
        aggregate: Array.from({ length: POINTS }, (_, i) => ({
            nodes: nodes.length,
            cpu: mean(series.map((node) => node.cpu[i]!)),
            mem: mean(series.map((node) => node.mem[i]!)),
        })),
        nodes: perNode,
    };
}

/**
 * The sampler starts empty on every launch and reads every 12 s, so a chart shot of the app as it is
 * would wait minutes for a line and draw a different one each run. The app is left as it ships:
 * instead, the harness answers the three channels the charts read with a history of its own, from
 * outside, by replacing their handlers in main through Playwright's `app.evaluate` and Electron's
 * public `ipcMain`. Every other channel, the usage figures beside the charts included, still
 * answers from the cluster. The answer is the envelope `registerHandlers` returns, `{ ok, data }`.
 */
export async function answerChartsWith(app: ElectronApplication, history = demoHistory()): Promise<void> {
    await app.evaluate(
        ({ ipcMain }, { seed, interval }) => {
            const answer = (data: unknown) => ({ ok: true, data });
            const replace = (channel: string, handler: (input: unknown) => unknown) => {
                ipcMain.removeHandler(channel);
                ipcMain.handle(channel, (_event, input: unknown) => answer(handler(input)));
            };
            replace('metrics.sparklines', () => ({
                nodes: seed.aggregate.map((point) => point.nodes),
                cpu: seed.aggregate.map((point) => point.cpu),
                mem: seed.aggregate.map((point) => point.mem),
            }));
            // Stamped when asked, so the newest point is always now.
            replace('metrics.workloadHealth', () => {
                const now = Date.now();
                return seed.aggregate.map((point, i) => ({
                    t: now - (seed.aggregate.length - 1 - i) * interval,
                    cpu: point.cpu,
                    mem: point.mem,
                }));
            });
            replace('metrics.nodeSeries', (input) => {
                const name = (input as { name?: string } | undefined)?.name ?? '';
                return seed.nodes[name] ?? { cpu: [], mem: [] };
            });
        },
        { seed: history, interval: SAMPLE_INTERVAL_MS },
    );
}
