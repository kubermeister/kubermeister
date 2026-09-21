import { describe, expect, it } from 'vitest';
import { invalidateClusterQueries, ipcQueryKey, queryClient } from '../../../src/renderer/lib/query';

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
