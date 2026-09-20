import { QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
}));

const { queryClient, ipcQueryKey } = await import('@/lib/query');
const { selectNamespace, switchContext } = await import('@/lib/scope');

const listKey = ipcQueryKey('resources.list', { kind: 'Pod' });
const activeKey = ipcQueryKey('namespace.active', {});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('selectNamespace', () => {
    afterEach(async () => {
        // A reset refetches what is mounted; cancel it so a read left pending cannot leak into the next test.
        await queryClient.cancelQueries();
        queryClient.clear();
    });

    beforeEach(() => {
        invoke.mockReset();
        queryClient.clear();
        queryClient.setQueryData(listKey, { kind: 'Pod', items: [{ name: 'web-1', namespace: 'team-a' }] });
        queryClient.setQueryData(activeKey, { name: 'team-a' });
    });

    it('drops every cluster query as soon as main has switched, without waiting for the re-read', async () => {
        // The lists must go back to loading the moment main has switched, not once the active
        // namespace has been read back; a slow answer there must not hold the old rows on screen.
        const neverAnswers = new Promise<never>(() => {});
        invoke.mockImplementation((channel: string) =>
            channel === 'namespace.set' ? Promise.resolve({ namespace: 'kube-system' }) : neverAnswers,
        );
        // The top bar keeps that read mounted, which is what makes an awaited invalidation wait.
        const observer = new QueryObserver(queryClient, {
            queryKey: activeKey,
            queryFn: () => invoke('namespace.active', {}),
        });
        const unsubscribe = observer.subscribe(() => {});
        const done = selectNamespace('kube-system');
        await flush();
        expect(invoke).toHaveBeenCalledWith('namespace.set', { namespace: 'kube-system' });
        expect(queryClient.getQueryData(listKey)).toBeUndefined();
        expect(queryClient.getQueryData(activeKey)).toBeUndefined();
        unsubscribe();
        await queryClient.cancelQueries();
        await done;
    });

    it('keeps the rows until main has actually switched, so a failed switch leaves the old scope on screen', async () => {
        let settle: (() => void) | undefined;
        invoke.mockImplementation(() => new Promise<void>((resolve) => (settle = resolve)));
        const done = selectNamespace('kube-system');
        await flush();
        expect(queryClient.getQueryData(listKey)).toBeDefined();
        settle?.();
        await done;
        expect(queryClient.getQueryData(listKey)).toBeUndefined();
    });
});

describe('switchContext', () => {
    it('resets cluster queries once the context has changed', async () => {
        invoke.mockReset();
        invoke.mockResolvedValue(undefined);
        queryClient.clear();
        queryClient.setQueryData(listKey, { kind: 'Pod', items: [] });
        await switchContext('beta');
        expect(invoke).toHaveBeenCalledWith('context.set', { name: 'beta' });
        expect(queryClient.getQueryData(listKey)).toBeUndefined();
    });

    it('reruns the startup checks once the context has changed, so the connection notice follows it', async () => {
        invoke.mockReset();
        invoke.mockImplementation(async (channel: string) =>
            channel === 'startupChecks' ? { ok: true, checks: [] } : undefined,
        );
        queryClient.clear();
        const startupKey = ipcQueryKey('startupChecks', {});
        queryClient.setQueryData(startupKey, { ok: false, checks: [] });
        // The gate and the notice keep the report mounted, which is what makes the invalidation refetch.
        const observer = new QueryObserver(queryClient, {
            queryKey: startupKey,
            queryFn: () => invoke('startupChecks', {}),
            staleTime: Infinity,
        });
        const unsubscribe = observer.subscribe(() => {});
        try {
            await switchContext('beta');
            const order = invoke.mock.calls.map(([channel]) => channel as string);
            expect(order.lastIndexOf('startupChecks')).toBeGreaterThan(order.indexOf('context.set'));
            expect(queryClient.getQueryData(startupKey)).toEqual({ ok: true, checks: [] });
        } finally {
            unsubscribe();
            await queryClient.cancelQueries();
            queryClient.clear();
        }
    });
});
