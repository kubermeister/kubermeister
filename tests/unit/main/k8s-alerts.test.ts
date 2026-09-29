import type { CoreV1Event, V1Node, V1Pod } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listPodForAllNamespaces = vi.fn();
const listEventForAllNamespaces = vi.fn();
const listNode = vi.fn();
const listJobForAllNamespaces = vi.fn();
const listPersistentVolumeClaimForAllNamespaces = vi.fn();
vi.mock('../../../src/main/k8s/client.js', () => ({
    apis: () => ({
        core: {
            listPodForAllNamespaces,
            listEventForAllNamespaces,
            listNode,
            listPersistentVolumeClaimForAllNamespaces,
        },
        batch: { listJobForAllNamespaces },
    }),
}));
vi.mock('../../../src/main/k8s/sampler.js', () => ({
    ensureSampler: vi.fn(),
    podUsage: vi.fn(),
    containerUsage: vi.fn(),
    percent: vi.fn(),
}));

const alerts = await import('../../../src/main/k8s/alerts.js');

function pod(
    name: string,
    phase: string,
    extra: { waiting?: string; restarts?: number; deleting?: boolean } = {},
): V1Pod {
    return {
        metadata: { name, namespace: 'team-a', deletionTimestamp: extra.deleting ? new Date() : undefined },
        spec: { containers: [{ name: 'c' }] },
        status: {
            phase,
            containerStatuses: [
                {
                    name: 'c',
                    ready: phase === 'Running',
                    restartCount: extra.restarts ?? 0,
                    image: 'x',
                    imageID: 'x',
                    state: extra.waiting ? { waiting: { reason: extra.waiting } } : { running: {} },
                },
            ],
        },
    } as V1Pod;
}
function node(name: string, ready: boolean, unschedulable = false): V1Node {
    return {
        metadata: { name },
        spec: { unschedulable },
        status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
    } as V1Node;
}

/** Script the phase-selected pod lists the alerts ask for; anything unselected must not be listed. */
function podsByPhase(pods: V1Pod[]) {
    listPodForAllNamespaces.mockImplementation(async (params?: { fieldSelector?: string }) => {
        const phase = params?.fieldSelector?.match(/^status\.phase=(\w+)$/)?.[1];
        if (!phase) throw new Error(`unexpected pod list: ${JSON.stringify(params)}`);
        return { items: pods.filter((p) => p.status?.phase === phase) };
    });
}

const NOW = Date.parse('2026-09-18T12:00:00Z');
function backoff(name: string, message: string, minutesAgo: number, count = 1): CoreV1Event {
    return {
        metadata: { name: `${name}.ev`, namespace: 'team-a' },
        type: 'Warning',
        reason: 'BackOff',
        message,
        count,
        firstTimestamp: new Date(NOW - minutesAgo * 60_000),
        lastTimestamp: new Date(NOW - minutesAgo * 60_000),
        involvedObject: { kind: 'Pod', name, namespace: 'team-a' },
    } as CoreV1Event;
}

describe('alerts', () => {
    beforeEach(() => {
        listPodForAllNamespaces.mockReset();
        listEventForAllNamespaces.mockReset();
        listEventForAllNamespaces.mockResolvedValue({ items: [] });
        listNode.mockReset();
        listNode.mockResolvedValue({ items: [] });
        podsByPhase([]);
        listJobForAllNamespaces.mockReset();
        listJobForAllNamespaces.mockResolvedValue({ items: [] });
        listPersistentVolumeClaimForAllNamespaces.mockReset();
        listPersistentVolumeClaimForAllNamespaces.mockResolvedValue({ items: [] });
    });

    it('derives pending and failed pod alerts from phase-selected lists, never from every pod', async () => {
        podsByPhase([
            pod('pull', 'Pending', { waiting: 'ErrImagePull' }),
            pod('init-crash', 'Pending', { waiting: 'CrashLoopBackOff', restarts: 3 }),
            pod('dead', 'Failed'),
            pod('wait', 'Pending'),
            pod('fine', 'Running', { restarts: 4 }),
        ]);
        const result = await alerts.podAlerts(NOW);
        expect(result).toEqual([
            { tone: 'danger', title: 'Image pull failure: pull', detail: 'team-a/pull' },
            { tone: 'danger', title: 'CrashLoopBackOff: init-crash', detail: '3 restarts — team-a/init-crash' },
            { tone: 'warn', title: 'Pod pending: wait', detail: 'team-a/wait' },
            { tone: 'danger', title: 'Pod failed: dead', detail: 'team-a/dead' },
        ]);
        expect(listPodForAllNamespaces.mock.calls.map((c) => c[0]?.fieldSelector).sort()).toEqual([
            'status.phase=Failed',
            'status.phase=Pending',
        ]);
        expect(listEventForAllNamespaces).toHaveBeenCalledWith({
            fieldSelector: 'type=Warning,reason=BackOff,involvedObject.kind=Pod',
        });
    });

    it('reads a crash-looping init container as a crash loop rather than a pending pod', async () => {
        const stuck = pod('init-loop', 'Pending');
        stuck.status!.initContainerStatuses = [
            {
                name: 'migrate',
                ready: false,
                restartCount: 5,
                image: 'x',
                imageID: 'x',
                state: { waiting: { reason: 'CrashLoopBackOff' } },
            },
        ];
        podsByPhase([stuck]);
        await expect(alerts.podAlerts(NOW)).resolves.toEqual([
            { tone: 'danger', title: 'CrashLoopBackOff: init-loop', detail: '5 restarts — team-a/init-loop' },
        ]);
    });

    it('never raises a high-restarts alert: healthy pods are not read at all', async () => {
        podsByPhase([pod('flaky', 'Running', { restarts: 50 })]);
        await expect(alerts.podAlerts(NOW)).resolves.toEqual([]);
    });

    it('reads crash loops and image back-offs off recent Warning events, once per pod', async () => {
        listEventForAllNamespaces.mockResolvedValue({
            items: [
                backoff('crash', 'Back-off restarting failed container app in pod crash_team-a(uid)', 1, 12),
                backoff('crash', 'Back-off restarting failed container app in pod crash_team-a(uid)', 5, 3),
                backoff('stale', 'Back-off restarting failed container', 25),
                backoff('pull', 'Back-off pulling image "ghcr.io/x/y:1"', 2),
                backoff('once', 'Back-off restarting failed container', 3),
                { ...backoff('nameless', 'Back-off restarting failed container', 1), involvedObject: { kind: 'Pod' } },
            ],
        });
        await expect(alerts.podAlerts(NOW)).resolves.toEqual([
            {
                tone: 'danger',
                title: 'CrashLoopBackOff: crash',
                detail: '15 back-offs in the last 10 min — team-a/crash',
            },
            { tone: 'danger', title: 'Image pull failure: pull', detail: 'team-a/pull' },
            { tone: 'danger', title: 'CrashLoopBackOff: once', detail: '1 back-off in the last 10 min — team-a/once' },
        ]);
    });

    it('never quotes an event lifetime count as the back-offs of the last 10 minutes', async () => {
        const since = (minutes: number) => new Date(NOW - minutes * 60_000);
        const message = 'Back-off restarting failed container';
        listEventForAllNamespaces.mockResolvedValue({
            items: [
                { ...backoff('fresh', message, 1, 4), firstTimestamp: since(8) },
                { ...backoff('old', message, 1, 200), firstTimestamp: since(3 * 24 * 60) },
                { ...backoff('both', message, 1, 5), firstTimestamp: since(4) },
                {
                    ...backoff('both', message, 2, 30),
                    metadata: { name: 'both.ev2', namespace: 'team-a' },
                    firstTimestamp: since(90),
                },
                { ...backoff('undated', message, 1, 7), firstTimestamp: undefined },
                { ...backoff('single', message, 1), firstTimestamp: undefined },
            ],
        });
        expect((await alerts.podAlerts(NOW)).map((a) => a.detail)).toEqual([
            '4 back-offs in the last 10 min — team-a/fresh',
            '200 back-offs in the last 3d — team-a/old',
            '35 back-offs in the last 1h30m — team-a/both',
            '7 back-offs, the latest in the last 10 min — team-a/undated',
            '1 back-off in the last 10 min — team-a/single',
        ]);
    });

    it('reads the event time from whichever stamp the event carries', async () => {
        const base = backoff('crash', 'Back-off restarting failed container', 0);
        listEventForAllNamespaces.mockResolvedValue({
            items: [
                { ...base, lastTimestamp: undefined, eventTime: new Date(NOW - 60_000) },
                {
                    ...base,
                    involvedObject: { kind: 'Pod', name: 'older', namespace: 'team-a' },
                    lastTimestamp: undefined,
                    metadata: { name: 'older.ev', namespace: 'team-a', creationTimestamp: new Date(NOW - 60_000) },
                },
                {
                    ...base,
                    involvedObject: { kind: 'Pod', name: 'undated', namespace: 'team-a' },
                    lastTimestamp: undefined,
                    metadata: { name: 'undated.ev', namespace: 'team-a' },
                },
            ],
        });
        expect((await alerts.podAlerts(NOW)).map((a) => a.title)).toEqual([
            'CrashLoopBackOff: crash',
            'CrashLoopBackOff: older',
        ]);
    });

    it('does not report a pod twice when both a selector and an event name it', async () => {
        podsByPhase([pod('pull', 'Pending', { waiting: 'ErrImagePull' })]);
        listEventForAllNamespaces.mockResolvedValue({ items: [backoff('pull', 'Back-off pulling image "x"', 1)] });
        await expect(alerts.podAlerts(NOW)).resolves.toEqual([
            { tone: 'danger', title: 'Image pull failure: pull', detail: 'team-a/pull' },
        ]);
    });

    it('treats a failing pod or event source as empty rather than failing the alerts', async () => {
        listPodForAllNamespaces.mockRejectedValue(new Error('forbidden'));
        listEventForAllNamespaces.mockRejectedValue(new Error('forbidden'));
        await expect(alerts.podAlerts(NOW)).resolves.toEqual([]);
    });

    it('derives node alerts, with NotReady outranking cordoned', async () => {
        listNode.mockResolvedValue({ items: [node('a', true), node('b', false, true), node('c', true, true)] });
        expect(await alerts.nodeAlerts()).toEqual([
            { tone: 'danger', title: 'Node NotReady: b', detail: 'Ready condition is not True' },
            { tone: 'warn', title: 'Node cordoned: c', detail: 'Scheduling disabled' },
        ]);
    });

    it('sorts danger first, caps the list, and survives a failing source', async () => {
        podsByPhase(Array.from({ length: 30 }, (_, i) => pod(`p${i}`, 'Pending')));
        listNode.mockRejectedValue(new Error('forbidden'));
        const result = await alerts.listAlerts();
        expect(result).toHaveLength(alerts.MAX_ALERTS);
        expect(result.every((a) => a.tone === 'warn')).toBe(true);

        podsByPhase([pod('wait', 'Pending')]);
        listNode.mockResolvedValue({ items: [node('b', false)] });
        expect((await alerts.listAlerts()).map((a) => a.tone)).toEqual(['danger', 'warn']);
    });

    it('reports failed jobs with their completion ratio', async () => {
        listJobForAllNamespaces.mockResolvedValue({
            items: [
                {
                    metadata: { name: 'import', namespace: 'team-a' },
                    spec: { completions: 3 },
                    status: { succeeded: 1, conditions: [{ type: 'Failed', status: 'True' }] },
                },
                {
                    metadata: { name: 'ok', namespace: 'team-a' },
                    status: { conditions: [{ type: 'Complete', status: 'True' }] },
                },
            ],
        });
        expect(await alerts.jobAlerts()).toEqual([
            { tone: 'danger', title: 'Job failed: import', detail: 'completions 1/3 — team-a/import' },
        ]);
        listJobForAllNamespaces.mockRejectedValue(new Error('forbidden'));
        expect(await alerts.jobAlerts()).toEqual([]);
    });

    it('reports claims that are pending or lost', async () => {
        listPersistentVolumeClaimForAllNamespaces.mockResolvedValue({
            items: [
                {
                    metadata: { name: 'data', namespace: 'team-a' },
                    spec: { storageClassName: 'local-path' },
                    status: { phase: 'Pending' },
                },
                { metadata: { name: 'gone', namespace: 'team-a' }, spec: {}, status: { phase: 'Lost' } },
                { metadata: { name: 'ok', namespace: 'team-a' }, spec: {}, status: { phase: 'Bound' } },
            ],
        });
        expect(await alerts.claimAlerts()).toEqual([
            { tone: 'warn', title: 'PVC Pending: data', detail: 'local-path — team-a/data' },
            { tone: 'danger', title: 'PVC Lost: gone', detail: '— — team-a/gone' },
        ]);
        listPersistentVolumeClaimForAllNamespaces.mockRejectedValue(new Error('denied'));
        expect(await alerts.claimAlerts()).toEqual([]);
    });
});
