import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from './helpers';

const invoke = vi.fn();
const stops: ReturnType<typeof vi.fn>[] = [];
const handlers: ((message: unknown) => void)[] = [];
const stream = vi.fn((_channel: string, _input: unknown, onMessage: (message: unknown) => void) => {
    const stop = vi.fn();
    stops.push(stop);
    handlers.push(onMessage);
    return { stop, send: vi.fn() };
});
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    stream,
}));

const toasts = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', async () => ({
    ...(await vi.importActual<typeof import('sonner')>('sonner')),
    toast: toasts,
}));

const { ForwardManager } = await import('@/components/layout/forward-manager');
const { forwardSnapshot, forwardUrl, startForward, stopAllForwards, stopForward } = await import('@/lib/port-forwards');
const { rememberForward } = await import('@/lib/forward-memory');
const { QueryClient } = await import('@tanstack/react-query');
const { settingsFixture } = await import('./settings-fixture');

const SETTINGS = settingsFixture({
    data: {
        forwards: [
            { context: 'alpha', kind: 'Service', namespace: 'team-a', name: 'api', targetPort: 80, localPort: 8081 },
            { context: 'beta', kind: 'Pod', namespace: 'team-a', name: 'other', targetPort: 80, localPort: 8082 },
        ],
    },
    updates: { mode: 'check' },
});
const listening = (localPort: number, pod?: string) => ({
    type: 'data',
    data: { status: 'listening', localPort, targetPort: 8080, pod },
});

beforeEach(() => {
    invoke.mockReset();
    stream.mockClear();
    stops.length = 0;
    handlers.length = 0;
    toasts.success.mockReset();
    invoke.mockImplementation(async (channel: string) => {
        if (channel === 'settings.get') return SETTINGS;
        if (channel === 'context.current') return { name: 'alpha', cluster: 'a', user: 'u', current: true };
        return null;
    });
});

afterEach(() => stopAllForwards());

describe('the forward store', () => {
    it('opens one stream per forward and reuses the one already on a local port', () => {
        const target = { kind: 'Pod' as const, name: 'web-1', namespace: 'team-a', targetPort: 8080, localPort: 9090 };
        const first = startForward(target);
        expect(startForward(target)).toBe(first);
        expect(stream).toHaveBeenCalledTimes(1);

        startForward({ ...target, localPort: 9091 });
        expect(forwardSnapshot()).toHaveLength(2);
    });

    it('keeps the listening state, and the pod a service resolved to', async () => {
        startForward({ kind: 'Service', name: 'api', namespace: 'team-a', targetPort: 8080, localPort: 9090 });
        act(() => handlers[0]!(listening(9090, 'api-abc')));
        await waitFor(() => expect(forwardSnapshot()[0]!.status).toMatchObject({ pod: 'api-abc' }));
    });

    it('reports a failure without dropping the forward, and ends one main closed', async () => {
        startForward({ kind: 'Pod', name: 'web-1', namespace: 'team-a', targetPort: 8080, localPort: 9090 });
        act(() => handlers[0]!({ type: 'error', message: 'address in use' }));
        await waitFor(() => expect(forwardSnapshot()[0]!.error).toBe('address in use'));

        act(() => handlers[0]!({ type: 'end' }));
        await waitFor(() => expect(forwardSnapshot()).toEqual([]));
    });

    it('starts again over a forward that never bound, rather than handing back the dead one', async () => {
        const target = { kind: 'Pod' as const, name: 'web-1', namespace: 'team-a', targetPort: 8080, localPort: 9090 };
        const dead = startForward(target);
        // Main reports a bind failure as an error with no end, so the entry would otherwise stay forever.
        act(() => handlers[0]!({ type: 'error', message: 'listen EADDRINUSE: address already in use' }));
        await waitFor(() => expect(forwardSnapshot()[0]!.error).toMatch(/EADDRINUSE/));

        const retried = startForward(target);
        expect(retried).not.toBe(dead);
        expect(stream).toHaveBeenCalledTimes(2);
        expect(stops[0]).toHaveBeenCalledTimes(1);
        expect(forwardSnapshot()).toEqual([expect.objectContaining({ id: dead.id, status: null, error: null })]);

        // The old stream's late messages no longer reach the new forward.
        act(() => handlers[0]!({ type: 'end' }));
        act(() => handlers[1]!(listening(9090)));
        await waitFor(() => expect(forwardSnapshot()[0]!.status).toMatchObject({ localPort: 9090 }));
    });

    it('hands back a forward that listened and then saw a failed connection', async () => {
        const target = { kind: 'Pod' as const, name: 'web-1', namespace: 'team-a', targetPort: 8080, localPort: 9090 };
        const first = startForward(target);
        act(() => handlers[0]!(listening(9090)));
        act(() => handlers[0]!({ type: 'error', message: 'connection refused' }));
        await waitFor(() => expect(forwardSnapshot()[0]!.error).toBe('connection refused'));
        expect(startForward(target).id).toBe(first.id);
        expect(stream).toHaveBeenCalledTimes(1);
    });

    it('stops every forward at once, which is what a context switch does', () => {
        startForward({ kind: 'Pod', name: 'web-1', namespace: 'team-a', targetPort: 8080, localPort: 9090 });
        startForward({ kind: 'Pod', name: 'web-2', namespace: 'team-a', targetPort: 8080, localPort: 9091 });
        stopAllForwards();
        expect(forwardSnapshot()).toEqual([]);
        expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    });

    it('names the address a forward listens on', () => {
        expect(forwardUrl({ localPort: 9090 })).toBe('http://127.0.0.1:9090');
    });
});

describe('the forward manager', () => {
    it('stays hidden until there is something to show', () => {
        invoke.mockImplementation(async (channel: string) =>
            channel === 'context.current' ? { name: 'gamma', cluster: 'a', user: 'u', current: true } : null,
        );
        renderWithQuery(<ForwardManager />);
        expect(screen.queryByTestId('forward-manager')).not.toBeInTheDocument();
    });

    it('lists open forwards with their address, and stops one on request', async () => {
        renderWithQuery(<ForwardManager />);
        startForward({ kind: 'Pod', name: 'web-1', namespace: 'team-a', targetPort: 8080, localPort: 9090 });
        act(() => handlers[0]!(listening(9090)));

        await userEvent.click(await screen.findByRole('button', { name: 'Port forwards' }));
        const list = await screen.findByTestId('forward-list');
        const row = list.querySelector('[data-forward="web-1"]') as HTMLElement;
        expect(row).toHaveTextContent('http://127.0.0.1:9090 → 8080');

        await userEvent.click(within(row).getByRole('button', { name: 'Stop forward web-1' }));
        await waitFor(() => expect(forwardSnapshot()).toEqual([]));
    });

    it('offers a forward remembered on this context, and not one from another', async () => {
        renderWithQuery(<ForwardManager />);
        await userEvent.click(await screen.findByRole('button', { name: 'Port forwards' }));
        const list = await screen.findByTestId('forward-list');
        expect(list.querySelector('[data-remembered="api"]')).toBeInTheDocument();
        // The one saved against another context is not offered here.
        expect(list.querySelector('[data-remembered="other"]')).not.toBeInTheDocument();

        await userEvent.click(within(list).getByRole('button', { name: 'Restore forward api' }));
        await waitFor(() =>
            expect(stream).toHaveBeenCalledWith(
                'pods.portForward',
                { kind: 'Service', name: 'api', namespace: 'team-a', targetPort: 80, localPort: 8081 },
                expect.any(Function),
            ),
        );
        expect(toasts.success).toHaveBeenCalledWith('Forwarding api again');
    });

    it('offers a remembered forward unless that very forward is running', async () => {
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'settings.get')
                return settingsFixture({
                    data: {
                        forwards: [
                            {
                                context: 'alpha',
                                kind: 'Pod',
                                namespace: 'team-a',
                                name: 'web',
                                targetPort: 80,
                                localPort: 8080,
                            },
                            {
                                context: 'alpha',
                                kind: 'Pod',
                                namespace: 'team-a',
                                name: 'web',
                                targetPort: 443,
                                localPort: 8443,
                            },
                            {
                                context: 'alpha',
                                kind: 'Service',
                                namespace: 'team-a',
                                name: 'web',
                                targetPort: 80,
                                localPort: 8081,
                            },
                        ],
                    },
                });
            if (channel === 'context.current') return { name: 'alpha', cluster: 'a', user: 'u', current: true };
            return null;
        });
        renderWithQuery(<ForwardManager />);
        startForward({ kind: 'Pod', name: 'web', namespace: 'team-a', targetPort: 80, localPort: 8080 });
        act(() => handlers[0]!(listening(8080)));
        await userEvent.click(await screen.findByRole('button', { name: 'Port forwards' }));
        const list = await screen.findByTestId('forward-list');
        await waitFor(() => expect(list.querySelectorAll('[data-remembered="web"]')).toHaveLength(2));
        expect(list).toHaveTextContent('Pod web:8443 → 443');
        expect(list).toHaveTextContent('Service web:8081 → 80');
        expect(list).not.toHaveTextContent('Pod web:8080 → 80');
    });

    it('offers a remembered forward again over one that could not bind', async () => {
        renderWithQuery(<ForwardManager />);
        startForward({ kind: 'Service', name: 'api', namespace: 'team-a', targetPort: 80, localPort: 8081 });
        act(() => handlers[0]!({ type: 'error', message: 'listen EADDRINUSE' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Port forwards' }));
        const list = await screen.findByTestId('forward-list');
        await userEvent.click(await within(list).findByRole('button', { name: 'Restore forward api' }));
        expect(stream).toHaveBeenCalledTimes(2);
        await waitFor(() => expect(forwardSnapshot()).toEqual([expect.objectContaining({ error: null })]));
    });

    it('opens the forwarded address in the browser', async () => {
        const open = vi.fn();
        vi.stubGlobal('open', open);
        renderWithQuery(<ForwardManager />);
        startForward({ kind: 'Pod', name: 'web-1', namespace: 'team-a', targetPort: 8080, localPort: 9090 });
        act(() => handlers[0]!(listening(9090)));
        await userEvent.click(await screen.findByRole('button', { name: 'Port forwards' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Open http://127.0.0.1:9090' }));
        expect(open).toHaveBeenCalledWith('http://127.0.0.1:9090', '_blank');
    });

    it('does not offer to open a forward that is not listening yet', async () => {
        renderWithQuery(<ForwardManager />);
        const forward = startForward({
            kind: 'Pod',
            name: 'web-1',
            namespace: 'team-a',
            targetPort: 8080,
            localPort: 9090,
        });
        await userEvent.click(await screen.findByRole('button', { name: 'Port forwards' }));
        expect(await screen.findByRole('button', { name: 'Open http://127.0.0.1:9090' })).toBeDisabled();
        stopForward(forward.id);
    });
});

describe('remembering a forward', () => {
    /** A client of its own, since this is about what reaches settings rather than what renders. */
    const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

    it('saves it against the current context, replacing an identical one', async () => {
        const saved: unknown[] = [];
        invoke.mockImplementation(async (channel: string, input: unknown) => {
            if (channel === 'settings.get') return SETTINGS;
            if (channel === 'context.current') return { name: 'alpha', cluster: 'a', user: 'u', current: true };
            if (channel === 'settings.set') {
                saved.push(input);
                return SETTINGS;
            }
            return null;
        });
        await rememberForward(client(), {
            kind: 'Service',
            name: 'api',
            namespace: 'team-a',
            targetPort: 80,
            localPort: 8081,
        });
        const forwards = (saved[0] as { data: { forwards: unknown[] } }).data.forwards;
        // The identical entry is replaced rather than duplicated, and the other context's stays.
        expect(forwards).toHaveLength(2);
        expect(forwards).toContainEqual({
            context: 'alpha',
            kind: 'Service',
            name: 'api',
            namespace: 'team-a',
            targetPort: 80,
            localPort: 8081,
        });
    });

    it('remembers nothing when no context is active', async () => {
        invoke.mockImplementation(async (channel: string) => (channel === 'settings.get' ? SETTINGS : null));
        await rememberForward(client(), {
            kind: 'Pod',
            name: 'web-1',
            namespace: 'team-a',
            targetPort: 80,
            localPort: 9090,
        });
        expect(invoke).not.toHaveBeenCalledWith('settings.set', expect.anything());
    });
});
