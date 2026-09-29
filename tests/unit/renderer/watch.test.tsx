import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceListOutput } from '../../../src/shared/k8s/resources';
import type { StreamMessage, WatchEvent } from '../../../src/shared/streams';

const invoke = vi.fn();
let onMessage: ((message: StreamMessage<WatchEvent>) => void) | undefined;
const stop = vi.fn();
const stream = vi.fn((_channel: string, _input: unknown, handler: (message: StreamMessage<WatchEvent>) => void) => {
    onMessage = handler;
    return { stop, send: vi.fn() };
});
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    stream,
}));

const { applyWatchEvent, useWatchedList } = await import('@/lib/watch');

const row = (name: string, status = 'Running') => ({
    name,
    namespace: 'team-a',
    status,
    ready: '1/1',
    restarts: 0,
    age: '1m',
    node: 'n1',
    cpu: 0,
    mem: 0,
    cpuLimit: 0,
    memLimit: 0,
});
const list = (...names: string[]): ResourceListOutput =>
    ({ kind: 'Pod', items: names.map((n) => row(n)) }) as ResourceListOutput;
const event = (type: WatchEvent['type'], name: string, status = 'Running'): WatchEvent =>
    ({ kind: 'Pod', type, item: row(name, status) }) as WatchEvent;

describe('applyWatchEvent', () => {
    it('adds, replaces, and removes rows by namespaced name', () => {
        const added = applyWatchEvent(list('a'), event('added', 'b'));
        expect(added?.items.map((r) => r.name)).toEqual(['a', 'b']);
        const replayed = applyWatchEvent(added, event('added', 'a', 'Pending'));
        expect(replayed?.items.map((r) => [r.name, r.status])).toEqual([
            ['a', 'Pending'],
            ['b', 'Running'],
        ]);
        const modified = applyWatchEvent(replayed, event('modified', 'b', 'CrashLoop'));
        expect(modified?.items[1]?.status).toBe('CrashLoop');
        const deleted = applyWatchEvent(modified, event('deleted', 'a'));
        expect(deleted?.items.map((r) => r.name)).toEqual(['b']);
        expect(applyWatchEvent(deleted, event('deleted', 'missing'))?.items).toHaveLength(1);
    });

    it('leaves an unloaded list alone', () => {
        expect(applyWatchEvent(undefined, event('added', 'a'))).toBeUndefined();
    });
});

describe('useWatchedList', () => {
    let client: QueryClient;
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    beforeEach(() => {
        client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        invoke.mockReset();
        stream.mockClear();
        stop.mockClear();
        onMessage = undefined;
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'resources.list') return list('a');
            if (channel === 'namespace.active') return { name: 'team-a' };
            if (channel === 'context.current') return { name: 'alpha', cluster: 'c', user: 'u', current: true };
            return undefined;
        });
    });

    it('loads the list, opens a watch, and applies events into the same rows', async () => {
        const { result } = renderHook(() => useWatchedList('Pod'), { wrapper });
        await waitFor(() => expect(result.current.data?.map((r) => r.name)).toEqual(['a']));
        expect(stream).toHaveBeenCalledWith(
            'resources.watch',
            { kind: 'Pod', namespace: undefined },
            expect.any(Function),
        );
        expect(result.current.live).toBe(false);
        act(() => onMessage?.({ type: 'data', data: event('added', 'b') }));
        await waitFor(() => expect(result.current.data?.map((r) => r.name)).toEqual(['a', 'b']));
        expect(result.current.live).toBe(true);
        act(() => onMessage?.({ type: 'data', data: event('deleted', 'a') }));
        await waitFor(() => expect(result.current.data?.map((r) => r.name)).toEqual(['b']));
    });

    it('refetches the list and drops the live flag on a stream error, and stops the stream on unmount', async () => {
        const { result, unmount } = renderHook(() => useWatchedList('Pod'), { wrapper });
        await waitFor(() => expect(result.current.data).toHaveLength(1));
        act(() => onMessage?.({ type: 'data', data: event('added', 'b') }));
        await waitFor(() => expect(result.current.live).toBe(true));
        const listCalls = () => invoke.mock.calls.filter((c) => c[0] === 'resources.list').length;
        const before = listCalls();
        act(() => onMessage?.({ type: 'error', message: 'watch closed' }));
        await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
        expect(result.current.live).toBe(false);
        unmount();
        expect(stop).toHaveBeenCalledOnce();
    });

    // A list answer the test releases by hand, so events can arrive while it is still in flight.
    function deferredLists() {
        const pending: Array<{ resolve: (output: ResourceListOutput) => void; reject: (error: Error) => void }> = [];
        invoke.mockImplementation((channel: string) => {
            if (channel === 'resources.list') {
                return new Promise<ResourceListOutput>((resolve, reject) => pending.push({ resolve, reject }));
            }
            if (channel === 'namespace.active') return Promise.resolve({ name: 'team-a' });
            if (channel === 'context.current') {
                return Promise.resolve({ name: 'alpha', cluster: 'c', user: 'u', current: true });
            }
            return Promise.resolve(undefined);
        });
        return {
            count: () => pending.length,
            answer: (index: number, output: ResourceListOutput) => pending[index]?.resolve(output),
            fail: (index: number) => pending[index]?.reject(new Error('list failed')),
        };
    }

    it('keeps events that arrive before the list answers, since the list is the older of the two', async () => {
        const lists = deferredLists();
        const { result } = renderHook(() => useWatchedList('Pod'), { wrapper });
        await waitFor(() => expect(onMessage).toBeDefined());
        act(() => onMessage?.({ type: 'data', data: event('deleted', 'a') }));
        act(() => onMessage?.({ type: 'data', data: event('modified', 'b', 'CrashLoop') }));
        act(() => onMessage?.({ type: 'data', data: event('added', 'c') }));
        await act(async () => {
            lists.answer(0, list('a', 'b'));
        });
        await waitFor(() =>
            expect(result.current.data?.map((r) => [r.name, r.status])).toEqual([
                ['b', 'CrashLoop'],
                ['c', 'Running'],
            ]),
        );
    });

    it('keeps events applied during a refetch rather than letting the older answer overwrite them', async () => {
        const lists = deferredLists();
        const { result } = renderHook(() => useWatchedList('Pod'), { wrapper });
        await waitFor(() => expect(onMessage).toBeDefined());
        await act(async () => {
            lists.answer(0, list('a', 'b'));
        });
        await waitFor(() => expect(result.current.data).toHaveLength(2));
        act(() => onMessage?.({ type: 'error', message: 'watch closed' }));
        await waitFor(() => expect(lists.count()).toBe(2));
        act(() => onMessage?.({ type: 'data', data: event('deleted', 'a') }));
        await waitFor(() => expect(result.current.data?.map((r) => r.name)).toEqual(['b']));
        await act(async () => {
            lists.answer(1, list('a', 'b'));
        });
        await waitFor(() => expect(result.current.isFetching).toBe(false));
        expect(result.current.data?.map((r) => r.name)).toEqual(['b']);
        // Once the answer has taken the events in, a later list answer is newer than them.
        await act(async () => {
            void client.invalidateQueries({ queryKey: ['resources.list'] });
        });
        await waitFor(() => expect(lists.count()).toBe(3));
        await act(async () => {
            lists.answer(2, list('a', 'b'));
        });
        await waitFor(() => expect(result.current.data?.map((r) => r.name)).toEqual(['a', 'b']));
    });

    it('drops the held events when the refetch fails, leaving the rows they were applied to', async () => {
        const lists = deferredLists();
        const { result } = renderHook(() => useWatchedList('Pod'), { wrapper });
        await waitFor(() => expect(onMessage).toBeDefined());
        await act(async () => {
            lists.answer(0, list('a', 'b'));
        });
        await waitFor(() => expect(result.current.data).toHaveLength(2));
        act(() => onMessage?.({ type: 'error', message: 'watch closed' }));
        await waitFor(() => expect(lists.count()).toBe(2));
        act(() => onMessage?.({ type: 'data', data: event('deleted', 'a') }));
        await act(async () => {
            lists.fail(1);
        });
        await waitFor(() => expect(result.current.isFetching).toBe(false));
        expect(result.current.data?.map((r) => r.name)).toEqual(['b']);
        await act(async () => {
            void client.invalidateQueries({ queryKey: ['resources.list'] });
        });
        await waitFor(() => expect(lists.count()).toBe(3));
        await act(async () => {
            lists.answer(2, list('a', 'b'));
        });
        await waitFor(() => expect(result.current.data?.map((r) => r.name)).toEqual(['a', 'b']));
    });

    it('restarts the watch when the active namespace changes', async () => {
        let namespace = 'team-a';
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'resources.list') return list('a');
            if (channel === 'namespace.active') return { name: namespace };
            if (channel === 'context.current') return { name: 'alpha', cluster: 'c', user: 'u', current: true };
            return undefined;
        });
        const { result } = renderHook(() => useWatchedList('Pod'), { wrapper });
        await waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
        namespace = 'kube-system';
        await act(async () => {
            await client.invalidateQueries({ queryKey: ['namespace.active'] });
        });
        await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
        expect(stop).toHaveBeenCalledOnce();
        expect(result.current.live).toBe(false);
    });
});
