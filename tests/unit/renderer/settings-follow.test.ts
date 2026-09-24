import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubPayload } from '../../../src/shared/ipc-subscriptions';

type Handler = (payload: SubPayload<'settings.changed'>) => void;
const handlers = new Map<string, Handler>();
const unsubscribe = vi.fn();
const subscribe = vi.fn((channel: string, handler: Handler) => {
    handlers.set(channel, handler);
    return unsubscribe;
});
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke: vi.fn(),
    subscribe,
}));
const invalidateClusterQueries = vi.fn(async () => {});
vi.mock('@/lib/query', async () => ({
    ...(await vi.importActual<typeof import('@/lib/query')>('@/lib/query')),
    invalidateClusterQueries,
}));

const { followSettingsFile } = await import('@/lib/settings');

describe('following the settings file', () => {
    let client: QueryClient;

    beforeEach(() => {
        handlers.clear();
        vi.clearAllMocks();
        client = new QueryClient();
        vi.spyOn(client, 'invalidateQueries');
    });

    it('refetches the settings, the file and the startup report when the file changes', () => {
        const stop = followSettingsFile(client);
        handlers.get('settings.changed')?.({ reconnected: false });
        const keys = vi.mocked(client.invalidateQueries).mock.calls.map(([filters]) => filters?.queryKey?.[0]);
        expect(keys).toEqual(['settings.get', 'settingsFile.status', 'startupChecks']);
        // Nothing about the connection changed, so what was read from the cluster still stands.
        expect(invalidateClusterQueries).not.toHaveBeenCalled();
        stop();
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('starts every cluster read over when the connection was remade', () => {
        followSettingsFile(client);
        handlers.get('settings.changed')?.({ reconnected: true });
        expect(invalidateClusterQueries).toHaveBeenCalledOnce();
    });
});
