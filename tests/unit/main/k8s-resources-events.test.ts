import type { CoreV1Event } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = { listNamespacedEvent: vi.fn(), listEventForAllNamespaces: vi.fn() };
const client = {
    apis: () => ({ core }),
    listItems: async <T>(
        ns: string | undefined,
        namespaced: (ns: string) => Promise<{ items: T[] }>,
        all: () => Promise<{ items: T[] }>,
    ) => {
        const resolved = ns ?? client.getActiveNamespace() ?? undefined;
        return resolved ? namespaced(resolved) : all();
    },
    getActiveNamespace: vi.fn<() => string | null>(),
    resolveObjectNamespace: (explicit?: string) => explicit ?? client.getActiveNamespace(),
    isSafeSelectorValue: (value: string) => /^[A-Za-z0-9._-]+$/.test(value),
};
vi.mock('../../../src/main/k8s/client.js', () => client);

const events = await import('../../../src/main/k8s/resources/events.js');

function event(overrides: Partial<CoreV1Event> = {}): CoreV1Event {
    return {
        metadata: { name: 'e', namespace: 'team-a' },
        involvedObject: { kind: 'Pod', name: 'web-1' },
        type: 'Normal',
        reason: 'Scheduled',
        message: 'Successfully assigned',
        lastTimestamp: new Date('2026-09-15T12:00:05Z'),
        ...overrides,
    };
}

describe('event transforms', () => {
    it('picks the most recent timestamp field and tolerates missing or broken ones', () => {
        expect(events.eventTimestamp(event())).toBe('2026-09-15T12:00:05.000Z');
        expect(
            events.eventTimestamp(event({ lastTimestamp: undefined, eventTime: new Date('2026-09-15T11:00:00Z') })),
        ).toBe('2026-09-15T11:00:00.000Z');
        expect(
            events.eventTimestamp(
                event({ lastTimestamp: undefined, metadata: { creationTimestamp: new Date('2026-09-15T10:00:00Z') } }),
            ),
        ).toBe('2026-09-15T10:00:00.000Z');
        expect(events.eventTimestamp(event({ lastTimestamp: undefined, metadata: {} }))).toBeUndefined();
        expect(events.eventTimestamp(event({ lastTimestamp: new Date('nope') }))).toBeUndefined();
    });

    it('reads a repeating series by its last observation, not its first', () => {
        const series = event({
            lastTimestamp: undefined,
            eventTime: new Date('2026-09-15T09:00:00Z'),
            series: { count: 12, lastObservedTime: new Date('2026-09-15T12:30:00Z') },
        });
        expect(events.eventTimestamp(series)).toBe('2026-09-15T12:30:00.000Z');
        expect(events.eventTimestamp(event({ series: { count: 2, lastObservedTime: new Date('nope') } }))).toBe(
            '2026-09-15T12:00:05.000Z',
        );

        const older = event({ reason: 'older', lastTimestamp: new Date('2026-09-15T11:00:00Z') });
        const repeating = { ...series, reason: 'repeating' };
        expect(events.sortedByTimeDesc([older, repeating]).map((e) => e.reason)).toEqual(['repeating', 'older']);
    });

    it('renders clock time or a dash', () => {
        expect(events.clockTime('2026-09-15T12:00:05.000Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
        expect(events.clockTime(undefined)).toBe('—');
        expect(events.clockTime('garbage')).toBe('—');
    });

    it('maps an event to the view model with kind/name object and Warning detection', () => {
        expect(events.toClusterEvent(event())).toEqual({
            time: expect.stringMatching(/^\d{2}:\d{2}:\d{2}$/),
            type: 'Normal',
            reason: 'Scheduled',
            object: 'pod/web-1',
            namespace: 'team-a',
            message: 'Successfully assigned',
        });
        expect(events.toClusterEvent(event({ type: 'Warning' })).type).toBe('Warning');
        expect(events.toClusterEvent(event({ type: undefined })).type).toBe('Normal');
        expect(
            events.toClusterEvent(
                event({ involvedObject: {}, reason: undefined, message: undefined, metadata: { namespace: '' } }),
            ),
        ).toMatchObject({ object: '—', reason: '', message: '', namespace: undefined });
    });

    it('sorts newest first and sinks events without a timestamp', () => {
        const older = event({ reason: 'older', lastTimestamp: new Date('2026-09-15T11:00:00Z') });
        const newer = event({ reason: 'newer' });
        const none = event({ reason: 'none', lastTimestamp: undefined, metadata: {} });
        expect(events.sortedByTimeDesc([none, older, newer]).map((e) => e.reason)).toEqual(['newer', 'older', 'none']);
    });
});

describe('listEventsForObject', () => {
    beforeEach(() => {
        core.listNamespacedEvent.mockReset();
        core.listEventForAllNamespaces.mockReset();
        client.getActiveNamespace.mockReturnValue('active-ns');
    });

    it('queries the object namespace with a field selector and returns newest first', async () => {
        core.listNamespacedEvent.mockResolvedValue({
            items: [
                event({ reason: 'older', lastTimestamp: new Date('2026-09-15T11:00:00Z') }),
                event({ reason: 'newer' }),
            ],
        });
        const result = await events.listEventsForObject({ kind: 'Pod', name: 'web-1', namespace: 'team-a' });
        expect(core.listNamespacedEvent).toHaveBeenCalledWith({
            namespace: 'team-a',
            fieldSelector: 'involvedObject.kind=Pod,involvedObject.name=web-1',
        });
        expect(result.map((e) => e.reason)).toEqual(['newer', 'older']);
    });

    it('falls back to the active namespace when none is given', async () => {
        core.listNamespacedEvent.mockResolvedValue({ items: [] });
        await events.listEventsForObject({ kind: 'Pod', name: 'web-1' });
        expect(core.listNamespacedEvent).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'active-ns' }));
    });

    it('searches all namespaces for cluster-scoped kinds and none for a namespaced kind without one', async () => {
        core.listEventForAllNamespaces.mockResolvedValue({ items: [] });
        await events.listEventsForObject({ kind: 'Node', name: 'n1', namespace: 'ignored' });
        expect(core.listEventForAllNamespaces).toHaveBeenCalledWith({
            fieldSelector: 'involvedObject.kind=Node,involvedObject.name=n1',
        });
        // Events of same-named pods elsewhere are not this pod's, so nothing is listed.
        client.getActiveNamespace.mockReturnValue(null);
        await expect(events.listEventsForObject({ kind: 'Pod', name: 'web-1' })).resolves.toEqual([]);
        expect(core.listEventForAllNamespaces).toHaveBeenCalledTimes(1);
        expect(core.listNamespacedEvent).not.toHaveBeenCalled();
    });

    it('refuses unsafe selector values without touching the cluster', async () => {
        await expect(events.listEventsForObject({ kind: 'Pod', name: 'a,b=c' })).resolves.toEqual([]);
        await expect(events.listEventsForObject({ kind: 'Po d', name: 'x' })).resolves.toEqual([]);
        expect(core.listNamespacedEvent).not.toHaveBeenCalled();
    });

    it('classifies API failures under the channel op', async () => {
        core.listNamespacedEvent.mockRejectedValue(new Error('boom'));
        await expect(
            events.listEventsForObject({ kind: 'Pod', name: 'web-1', namespace: 'team-a' }),
        ).rejects.toMatchObject({ op: 'events.forObject' });
    });
});

describe('listRecentEvents', () => {
    beforeEach(() => {
        core.listEventForAllNamespaces.mockReset();
    });

    it('reads a bounded page across all namespaces and keeps the newest twenty', async () => {
        const items = Array.from({ length: 30 }, (_, i) =>
            event({ reason: `r${i}`, lastTimestamp: new Date(Date.UTC(2026, 8, 15, 12, 0, i)) }),
        );
        core.listEventForAllNamespaces.mockResolvedValue({ items });
        const result = await events.listRecentEvents();
        expect(core.listEventForAllNamespaces).toHaveBeenCalledWith({ limit: 500 });
        expect(result).toHaveLength(events.RECENT_EVENTS);
        expect(result[0]?.reason).toBe('r29');
        expect(result.at(-1)?.reason).toBe('r10');
    });

    it('classifies failures under its channel op', async () => {
        core.listEventForAllNamespaces.mockRejectedValue(new Error('boom'));
        await expect(events.listRecentEvents()).rejects.toMatchObject({ op: 'events.recent' });
    });
});

describe('listEvents', () => {
    beforeEach(() => {
        core.listNamespacedEvent.mockReset();
        core.listEventForAllNamespaces.mockReset();
        client.getActiveNamespace.mockReturnValue('team-a');
    });

    it('reads a bounded page in the active or explicit namespace, newest first', async () => {
        core.listNamespacedEvent.mockResolvedValue({
            items: [
                event({ reason: 'older', lastTimestamp: new Date('2026-09-15T11:00:00Z') }),
                event({ reason: 'newer' }),
            ],
        });
        expect((await events.listEvents()).map((e) => e.reason)).toEqual(['newer', 'older']);
        expect(core.listNamespacedEvent).toHaveBeenCalledWith({ namespace: 'team-a', limit: 500 });
        await events.listEvents('explicit');
        expect(core.listNamespacedEvent).toHaveBeenLastCalledWith({ namespace: 'explicit', limit: 500 });
    });

    it('falls back to every namespace and classifies failures', async () => {
        client.getActiveNamespace.mockReturnValue(null);
        core.listEventForAllNamespaces.mockResolvedValue({ items: [] });
        await expect(events.listEvents()).resolves.toEqual([]);
        expect(core.listEventForAllNamespaces).toHaveBeenCalledWith({ limit: 500 });
        core.listEventForAllNamespaces.mockRejectedValue(new Error('boom'));
        await expect(events.listEvents()).rejects.toMatchObject({ op: 'events.list' });
    });
});
