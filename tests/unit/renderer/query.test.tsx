import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
}));

const { invalidateClusterQueries, ipcQueryKey, queryClient, refreshAfterWrite, useIpcMutation, useIpcQuery } =
    await import('@/lib/query');

describe('query helpers', () => {
    it('builds keys as channel plus input so invalidation works by prefix', () => {
        expect(ipcQueryKey('nodes.get', { name: 'n1' })).toEqual(['nodes.get', { name: 'n1' }]);
    });

    it('forgets cluster data on a scope switch, refetches the contexts and leaves app-level queries alone', async () => {
        queryClient.setQueryData(['nodes.list', {}], [{ name: 'old-cluster-node' }]);
        queryClient.setQueryData(['resources.list', { kind: 'Pod' }], { kind: 'Pod', items: [{ name: 'old' }] });
        queryClient.setQueryData(['contexts.list', {}], [{ name: 'alpha' }]);
        queryClient.setQueryData(['settings.get', {}], { version: 1 });
        queryClient.setQueryData(['app.info', {}], {});
        queryClient.setQueryData(['update.state', {}], {});
        queryClient.setQueryData(['startupChecks', {}], {});
        queryClient.setQueryData(['chartRepositories.list', {}], []);
        await invalidateClusterQueries();
        const state = (key: unknown[]) => queryClient.getQueryState(key);
        // Reset, not merely stale: a screen must not keep rendering the previous cluster's rows
        // while a write could already reach the new one.
        expect(state(['nodes.list', {}])?.data).toBeUndefined();
        expect(state(['resources.list', { kind: 'Pod' }])?.data).toBeUndefined();
        expect(state(['contexts.list', {}])?.data).toEqual([{ name: 'alpha' }]);
        expect(state(['contexts.list', {}])?.isInvalidated).toBe(true);
        for (const channel of ['settings.get', 'app.info', 'update.state', 'startupChecks', 'chartRepositories.list']) {
            expect(state([channel, {}])?.data).toBeDefined();
            expect(state([channel, {}])?.isInvalidated).toBe(false);
        }
    });
});

describe('refreshing after a write', () => {
    const before = { kind: 'ConfigMap', items: [{ name: 'my-config', namespace: 'team-a' }] };
    const after = { kind: 'ConfigMap', items: [] };
    const listKey = ipcQueryKey('resources.list', { kind: 'ConfigMap' });

    function deferred<T>() {
        let resolve: (value: T) => void = () => {};
        const promise = new Promise<T>((settle) => {
            resolve = settle;
        });
        return { promise, resolve };
    }

    it('does not let a read that started before the write answer for after it', async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } });
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
        // The list screen was left mid-refetch: that read went out before the delete and is still
        // on its way back, with nobody watching the query any more.
        const early = deferred<unknown>();
        invoke.mockReset();
        invoke.mockImplementationOnce(() => early.promise);
        void client.prefetchQuery({
            queryKey: listKey,
            queryFn: () => invoke('resources.list', { kind: 'ConfigMap' }),
        });

        invoke.mockImplementation((channel: string) =>
            Promise.resolve(channel === 'resources.delete' ? { kind: 'ConfigMap', name: 'my-config' } : after),
        );
        const mutation = renderHook(
            () => useIpcMutation('resources.delete', { invalidates: () => [['resources.list']] }),
            { wrapper },
        );
        await mutation.result.current.mutateAsync({
            kind: 'ConfigMap',
            name: 'my-config',
            namespace: 'team-a',
            context: 'alpha',
        });

        // Back on the list, and only then does the old read come back, still holding the object.
        const list = renderHook(() => useIpcQuery('resources.list', { kind: 'ConfigMap' }), { wrapper });
        early.resolve(before);
        await waitFor(() => expect(list.result.current.data).toEqual(after));
        expect(invoke.mock.calls.filter(([channel]) => channel === 'resources.list')).toHaveLength(2);
    });

    it('refetches a query on screen and leaves one nobody watches to its next mount', async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } });
        client.setQueryData(listKey, before);
        client.setQueryData(ipcQueryKey('resources.get', { kind: 'ConfigMap', name: 'x', namespace: 'a' }), {});
        invoke.mockReset();
        await refreshAfterWrite(client, [['resources.list'], ['resources.get']]);
        expect(invoke).not.toHaveBeenCalled();
        expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
        expect(client.getQueryState(listKey)?.data).toEqual(before);
    });
});
