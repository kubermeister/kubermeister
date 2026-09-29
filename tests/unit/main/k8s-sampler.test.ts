import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readUsage = vi.fn();
const readNodeUsage = vi.fn();
vi.mock('../../../src/main/k8s/metrics.js', () => ({
    readUsage,
    readNodeUsage,
    containerUsageKey: (namespace: string, pod: string, container: string) => `${namespace}/${pod}/${container}`,
}));
const listNode = vi.fn();
vi.mock('../../../src/main/k8s/client.js', () => ({ apis: () => ({ core: { listNode } }) }));

const sampler = await import('../../../src/main/k8s/sampler.js');
const { currentAbortSignal } = await import('../../../src/main/k8s/abort.js');
const { readTimeoutMs } = await import('../../../src/main/k8s/errors.js');

const usageOf = (cpu: number) => ({
    pods: new Map([['team-a/web-1', { cpu, mem: 64 }]]),
    containers: new Map(),
});

const node = (name: string, cpu = '4', memory = '8Gi') => ({
    metadata: { name },
    status: { allocatable: { cpu, memory } },
});

describe('sampler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        sampler.stopSampler();
        sampler.resetHistory();
        readUsage.mockReset();
        readNodeUsage.mockReset();
        listNode.mockReset();
        readUsage.mockResolvedValue({
            pods: new Map([['team-a/web-1', { cpu: 250, mem: 64 }]]),
            containers: new Map(),
        });
        readNodeUsage.mockResolvedValue(new Map([['n1', { cpu: 1000, mem: 2048 }]]));
        listNode.mockResolvedValue({ items: [node('n1'), node('n2')] });
    });
    afterEach(() => {
        sampler.stopSampler();
        vi.useRealTimers();
    });

    it('computes percentages safely', () => {
        expect(sampler.percent(1, 4)).toBe(25);
        expect(sampler.percent(2, 3)).toBe(67);
        expect(sampler.percent(5, 0)).toBe(0);
    });

    it('records the latest usage and an aggregate point per sample, as percent of allocatable', async () => {
        await sampler.sampleOnce(1_000);
        expect(sampler.podUsage('team-a', 'web-1')).toEqual({ cpu: 250, mem: 64 });
        expect(sampler.podUsage('team-a', 'gone')).toBeUndefined();
        expect(sampler.nodeUsage('n1')).toEqual({ cpu: 1000, mem: 2048 });
        // 1000m of 8000m and 2048Mi of 16384Mi across two nodes.
        expect(sampler.clusterSparklines()).toEqual({ nodes: [2], cpu: [13], mem: [13] });
        expect(sampler.workloadHealth()).toEqual([{ t: 1_000, cpu: 13, mem: 13 }]);
        expect(sampler.nodeSeries('n1')).toEqual({ cpu: [25], mem: [25] });
        expect(sampler.nodeSeries('n2')).toEqual({ cpu: [0], mem: [0] });
        expect(sampler.nodeSeries('unknown')).toEqual({ cpu: [], mem: [] });
    });

    it('tracks a pod series from the moment it is requested and bumps it in the LRU', async () => {
        expect(sampler.trackResourceSeries('team-a', 'web-1')).toEqual({ cpu: [], mem: [] });
        await sampler.sampleOnce();
        readUsage.mockResolvedValue({ pods: new Map(), containers: new Map() });
        await sampler.sampleOnce();
        expect(sampler.trackResourceSeries('team-a', 'web-1')).toEqual({ cpu: [250, 0], mem: [64, 0] });
    });

    it('evicts the least recently requested pod past the cap', async () => {
        for (let i = 0; i < sampler.TRACKED_RESOURCES_CAP; i++) sampler.trackResourceSeries('ns', `pod-${i}`);
        await sampler.sampleOnce();
        sampler.trackResourceSeries('ns', 'pod-0'); // most recent again
        sampler.trackResourceSeries('ns', 'newcomer'); // evicts pod-1
        await sampler.sampleOnce();
        expect(sampler.trackResourceSeries('ns', 'pod-0').cpu).toHaveLength(2);
        expect(sampler.trackResourceSeries('ns', 'pod-1').cpu).toHaveLength(0);
    });

    it('bounds every ring buffer and drops nodes that disappear', async () => {
        for (let i = 0; i < sampler.BUFFER_POINTS + 5; i++) await sampler.sampleOnce(i);
        expect(sampler.clusterSparklines().cpu).toHaveLength(sampler.BUFFER_POINTS);
        expect(sampler.workloadHealth()[0]?.t).toBe(5);
        expect(sampler.nodeSeries('n1').cpu).toHaveLength(sampler.BUFFER_POINTS);
        listNode.mockResolvedValue({ items: [node('n1'), { metadata: {} }] });
        await sampler.sampleOnce();
        expect(sampler.nodeSeries('n2')).toEqual({ cpu: [], mem: [] });
        expect(sampler.clusterSparklines().nodes.at(-1)).toBe(2);
    });

    it('survives a failing node list and uses capacity when allocatable is missing', async () => {
        listNode.mockRejectedValue(new Error('down'));
        await sampler.sampleOnce();
        expect(sampler.clusterSparklines()).toEqual({ nodes: [0], cpu: [0], mem: [0] });
        listNode.mockResolvedValue({
            items: [{ metadata: { name: 'n1' }, status: { capacity: { cpu: '2', memory: '4Gi' } } }],
        });
        await sampler.sampleOnce();
        expect(sampler.nodeSeries('n1')).toEqual({ cpu: [50], mem: [50] });
    });

    it('samples immediately when started, then on the interval, and stops cleanly', async () => {
        sampler.ensureSampler();
        sampler.ensureSampler();
        await vi.advanceTimersByTimeAsync(0);
        expect(readUsage).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(sampler.SAMPLE_INTERVAL_MS);
        expect(readUsage).toHaveBeenCalledTimes(2);
        readUsage.mockRejectedValueOnce(new Error('metrics down'));
        await vi.advanceTimersByTimeAsync(sampler.SAMPLE_INTERVAL_MS);
        await vi.advanceTimersByTimeAsync(sampler.SAMPLE_INTERVAL_MS);
        expect(readUsage).toHaveBeenCalledTimes(4);
        sampler.stopSampler();
        await vi.advanceTimersByTimeAsync(sampler.SAMPLE_INTERVAL_MS * 3);
        expect(readUsage).toHaveBeenCalledTimes(4);
    });

    it('forgets everything on reset', async () => {
        sampler.trackResourceSeries('team-a', 'web-1');
        await sampler.sampleOnce();
        sampler.resetHistory();
        expect(sampler.podUsage('team-a', 'web-1')).toBeUndefined();
        expect(sampler.nodeUsage('n1')).toBeUndefined();
        expect(sampler.clusterSparklines().cpu).toEqual([]);
        expect(sampler.trackResourceSeries('team-a', 'web-1')).toEqual({ cpu: [], mem: [] });
    });

    it('gives up on a sample that never answers at the read ceiling, aborts it and keeps sampling', async () => {
        let signal: AbortSignal | undefined;
        readUsage.mockImplementationOnce(() => {
            signal = currentAbortSignal();
            return new Promise(() => {});
        });
        sampler.ensureSampler();
        await vi.advanceTimersByTimeAsync(0);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(readTimeoutMs());
        expect(signal?.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(sampler.SAMPLE_INTERVAL_MS);
        expect(readUsage).toHaveBeenCalledTimes(2);
        expect(sampler.clusterSparklines().cpu).toHaveLength(1);
    });

    it('records nothing from a sample that answers after its ceiling aborted it', async () => {
        let answer: (value: ReturnType<typeof usageOf>) => void = () => {};
        readUsage.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
        sampler.ensureSampler();
        await vi.advanceTimersByTimeAsync(readTimeoutMs());
        sampler.stopSampler();
        answer(usageOf(999));
        await vi.advanceTimersByTimeAsync(0);
        expect(sampler.podUsage('team-a', 'web-1')).toBeUndefined();
        expect(sampler.clusterSparklines().cpu).toEqual([]);
    });

    it('drops a sample that was running when the history was reset', async () => {
        sampler.trackResourceSeries('team-a', 'web-1');
        let answer: (value: ReturnType<typeof usageOf>) => void = () => {};
        readUsage.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
        const sample = sampler.sampleOnce();
        sampler.resetHistory();
        answer(usageOf(999));
        await sample;
        expect(sampler.podUsage('team-a', 'web-1')).toBeUndefined();
        expect(sampler.nodeUsage('n1')).toBeUndefined();
        expect(sampler.nodeSeries('n1')).toEqual({ cpu: [], mem: [] });
        expect(sampler.workloadHealth()).toEqual([]);
        await sampler.sampleOnce();
        expect(sampler.podUsage('team-a', 'web-1')).toEqual({ cpu: 250, mem: 64 });
        expect(sampler.clusterSparklines().cpu).toHaveLength(1);
    });
});
