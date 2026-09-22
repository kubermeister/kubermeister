import { ApiException, type V1Pod } from '@kubernetes/client-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const core = { listPodForAllNamespaces: vi.fn(), createNamespacedPodEviction: vi.fn() };
const objects = { patch: vi.fn() };
const client = {
    apis: () => ({ core, objects }),
    activeContextName: vi.fn<() => string>(() => 'alpha'),
    getActiveNamespace: vi.fn<() => string | null>(() => 'team-a'),
};
vi.mock('../../../src/main/k8s/client.js', () => client);

const drain = await import('../../../src/main/k8s/drain.js');
import { currentAbortSignal } from '../../../src/main/k8s/abort';
import type { StreamMessage } from '../../../src/shared/streams.js';

const OPTIONS = { force: false, deleteEmptyDirData: false };
const ON_ALPHA = { context: 'alpha', name: 'node-1', ...OPTIONS };

function pod(name: string, overrides: Partial<V1Pod> = {}): V1Pod {
    return {
        metadata: { name, namespace: 'team-a', ownerReferences: [{ kind: 'ReplicaSet' } as never] },
        spec: { nodeName: 'node-1' },
        status: { phase: 'Running' },
        ...overrides,
    } as V1Pod;
}

/** Collects what a stream pushed, so a drain can be read back as the sequence it reported. */
function collector() {
    const messages: StreamMessage[] = [];
    return {
        messages,
        send: (message: StreamMessage) => messages.push(message),
        events: () =>
            messages
                .filter((m): m is { type: 'data'; data: { type: string } } => m.type === 'data')
                .map((m) => m.data.type),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    client.activeContextName.mockReturnValue('alpha');
    objects.patch.mockResolvedValue({});
    core.createNamespacedPodEviction.mockResolvedValue({});
    core.listPodForAllNamespaces.mockResolvedValue({ items: [pod('web-1')] });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('what a drain leaves alone', () => {
    it('keeps the pods nothing would put back, and says which is which', () => {
        const pods = [
            pod('web-1'),
            pod('agent', {
                metadata: {
                    name: 'agent',
                    namespace: 'kube-system',
                    ownerReferences: [{ kind: 'DaemonSet' } as never],
                },
            }),
            pod('apiserver', {
                metadata: {
                    name: 'apiserver',
                    namespace: 'kube-system',
                    annotations: { 'kubernetes.io/config.mirror': 'x' },
                },
            }),
            pod('importer', { status: { phase: 'Succeeded' } }),
            pod('loose', { metadata: { name: 'loose', namespace: 'team-a' } }),
            pod('cache', { spec: { nodeName: 'node-1', volumes: [{ name: 'scratch', emptyDir: {} }] } }),
        ];
        const plan = drain.planFor(pods, OPTIONS);
        expect(plan.evict).toEqual([{ name: 'web-1', namespace: 'team-a' }]);
        expect(plan.skip).toEqual([
            { name: 'agent', namespace: 'kube-system', reason: 'daemonSet' },
            { name: 'apiserver', namespace: 'kube-system', reason: 'static' },
            { name: 'importer', namespace: 'team-a', reason: 'finished' },
            { name: 'loose', namespace: 'team-a', reason: 'unmanaged' },
            { name: 'cache', namespace: 'team-a', reason: 'emptyDir' },
        ]);
    });

    it('takes the pods the options allow, without ever touching a daemon set or a static pod', () => {
        const pods = [
            pod('loose', { metadata: { name: 'loose', namespace: 'team-a' } }),
            pod('cache', { spec: { nodeName: 'node-1', volumes: [{ name: 'scratch', emptyDir: {} }] } }),
            pod('agent', {
                metadata: {
                    name: 'agent',
                    namespace: 'kube-system',
                    ownerReferences: [{ kind: 'DaemonSet' } as never],
                },
            }),
        ];
        const plan = drain.planFor(pods, { force: true, deleteEmptyDirData: true });
        expect(plan.evict.map((p) => p.name)).toEqual(['loose', 'cache']);
        expect(plan.skip.map((p) => p.reason)).toEqual(['daemonSet']);
    });

    it('reads the plan for the node it names, for the options it is given', async () => {
        await expect(drain.getDrainPlan('node-1', OPTIONS)).resolves.toMatchObject({ evict: [{ name: 'web-1' }] });
        expect(core.listPodForAllNamespaces).toHaveBeenCalledWith({ fieldSelector: 'spec.nodeName=node-1' });
    });
});

describe('draining a node', () => {
    it('cordons first, reports the plan, then evicts pod by pod', async () => {
        const sink = collector();
        const controller = await drain.startNodeDrain(ON_ALPHA, sink.send);
        await vi.waitFor(() => expect(sink.messages.at(-1)).toEqual({ type: 'end' }));

        expect(objects.patch).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'Node', metadata: { name: 'node-1' }, spec: { unschedulable: true } }),
        );
        expect(sink.events()).toEqual(['cordoned', 'plan', 'evicting', 'evicted', 'done']);
        expect(core.createNamespacedPodEviction).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'web-1', namespace: 'team-a' }),
        );
        controller.stop();
    });

    it('evicts outside the read ceiling, so nothing cancels a wait that is meant to last', async () => {
        const scopes: Array<AbortSignal | undefined> = [];
        core.createNamespacedPodEviction.mockImplementation(() => {
            scopes.push(currentAbortSignal());
            return Promise.resolve({});
        });
        const sink = collector();
        await drain.startNodeDrain(ON_ALPHA, sink.send);
        await vi.waitFor(() => expect(sink.messages.at(-1)).toEqual({ type: 'end' }));
        expect(scopes).toEqual([undefined]);
    });

    it('passes a grace period on to each eviction when one is asked for', async () => {
        const sink = collector();
        await drain.startNodeDrain({ ...ON_ALPHA, gracePeriodSeconds: 0 }, sink.send);
        await vi.waitFor(() => expect(core.createNamespacedPodEviction).toHaveBeenCalled());
        expect(core.createNamespacedPodEviction.mock.calls[0][0].body.deleteOptions).toEqual({ gracePeriodSeconds: 0 });
    });

    it('counts a pod that is already gone as evicted rather than failing the drain', async () => {
        core.createNamespacedPodEviction.mockRejectedValue(new ApiException(404, 'gone', null, {}));
        const sink = collector();
        await drain.startNodeDrain(ON_ALPHA, sink.send);
        await vi.waitFor(() => expect(sink.messages.at(-1)).toEqual({ type: 'end' }));
        expect(sink.events()).toContain('evicted');
        expect(sink.messages.some((m) => m.type === 'error')).toBe(false);
    });

    it('waits out a disruption budget instead of forcing the pod out', async () => {
        vi.useFakeTimers();
        core.createNamespacedPodEviction
            .mockRejectedValueOnce(new ApiException(429, 'budget', null, {}))
            .mockResolvedValueOnce({});
        const sink = collector();
        await drain.startNodeDrain(ON_ALPHA, sink.send);
        await vi.waitFor(() => expect(sink.events()).toContain('blocked'));
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(() => expect(sink.events()).toContain('evicted'));
        expect(core.createNamespacedPodEviction).toHaveBeenCalledTimes(2);
    });

    it('ends at once when stopped, even mid-eviction, and leaves the node cordoned', async () => {
        core.listPodForAllNamespaces.mockResolvedValue({ items: [pod('web-1'), pod('web-2')] });
        // An eviction the API server never answers must not hold the stream open after a stop.
        core.createNamespacedPodEviction.mockImplementation(() => new Promise(() => {}));
        const sink = collector();
        const controller = await drain.startNodeDrain(ON_ALPHA, sink.send);
        await vi.waitFor(() => expect(sink.events()).toContain('evicting'));
        controller.stop();
        expect(sink.messages.at(-1)).toEqual({ type: 'end' });
        // A stopped drain never claims to be done, and the cordon it already applied stands.
        expect(sink.events()).not.toContain('done');
        expect(objects.patch).toHaveBeenCalledTimes(1);
    });

    it('gives up on a pod a budget never releases, and says how many were left', async () => {
        vi.useFakeTimers();
        core.createNamespacedPodEviction.mockRejectedValue(new ApiException(429, 'budget', null, {}));
        const sink = collector();
        await drain.startNodeDrain(ON_ALPHA, sink.send);
        await vi.waitFor(() => expect(sink.events()).toContain('blocked'));
        // Two minutes of a budget refusing is enough: the drain moves on rather than hanging.
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 5_000);
        await vi.waitFor(() => expect(sink.messages.at(-1)).toEqual({ type: 'end' }));
        const done = sink.messages.find(
            (m): m is { type: 'data'; data: { type: string; evicted: number; left: number } } =>
                m.type === 'data' && (m.data as { type: string }).type === 'done',
        );
        expect(done?.data).toMatchObject({ evicted: 0, left: 1 });
    });

    it('refuses a drain aimed at a context the app has left', async () => {
        client.activeContextName.mockReturnValue('beta');
        await expect(drain.startNodeDrain(ON_ALPHA, collector().send)).rejects.toMatchObject({ kind: 'conflict' });
        expect(objects.patch).not.toHaveBeenCalled();
    });

    it('reports a refused cordon as a stream error rather than an uncaught failure', async () => {
        objects.patch.mockRejectedValue(new ApiException(403, 'forbidden', null, {}));
        const sink = collector();
        await drain.startNodeDrain(ON_ALPHA, sink.send);
        await vi.waitFor(() => expect(sink.messages.at(-1)).toEqual({ type: 'end' }));
        expect(sink.messages.some((m) => m.type === 'error')).toBe(true);
        expect(core.createNamespacedPodEviction).not.toHaveBeenCalled();
    });
});
