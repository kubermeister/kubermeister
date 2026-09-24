import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeepLink } from '../../../src/shared/deep-link';
import { renderRoutes } from './helpers';
import { settingsFixture } from './settings-fixture';

const invoke = vi.fn();
const pushes = new Map<string, (payload: unknown) => void>();
const subscribe = vi.fn((channel: string, handler: (payload: unknown) => void) => {
    pushes.set(channel, handler);
    return () => pushes.delete(channel);
});
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    subscribe,
    stream: vi.fn(() => ({ stop: vi.fn(), send: vi.fn() })),
}));

const toasts = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', async () => ({
    ...(await vi.importActual<typeof import('sonner')>('sonner')),
    toast: toasts,
}));

const { routeTree } = await import('@/routeTree.gen');
const { copyablePath, linkablePath, planDeepLink } = await import('@/lib/deep-link');

const DEV = 'https://dev.example.com:6443';
const PROD = 'https://prod.example.com:6443';
const context = (name: string, server: string) => ({ name, cluster: name, server, user: name, current: false });

/** The link main is holding, answered once as `deepLink.take` does. */
let held: DeepLink | null = null;

const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'settings.get': settingsFixture(),
    'contexts.list': [context('dev', DEV), context('prod-admin', PROD)],
    'context.current': context('dev', DEV),
    'context.set': context('prod-admin', PROD),
    'namespaces.list': [],
    'namespace.active': { name: 'default' },
    'resources.list': { kind: 'Pod', items: [] },
};

function answer(channel: string): Promise<unknown> {
    if (channel === 'deepLink.take') {
        const link = held;
        held = null;
        return Promise.resolve({ link });
    }
    return Promise.resolve(data[channel]);
}

const setCalls = () => invoke.mock.calls.filter(([channel]) => channel === 'context.set');

describe('linkablePath', () => {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) });

    it('opens a path the route tree has, tab included', () => {
        expect(linkablePath(router, '/workloads/pods/default/web-1/logs')).toBe('/workloads/pods/default/web-1/logs');
        expect(linkablePath(router, '/workloads/pods')).toBe('/workloads/pods');
    });

    it('opens a cluster-scoped detail, which has no namespace segment', () => {
        expect(linkablePath(router, '/overview/nodes/worker-1/describe')).toBe('/overview/nodes/worker-1/describe');
    });

    it('opens a custom resource instance', () => {
        expect(linkablePath(router, '/addons/instances/widgets.example.com/default/w1')).toBe(
            '/addons/instances/widgets.example.com/default/w1',
        );
    });

    it('opens a Shell tab link on the object’s first tab instead', () => {
        expect(linkablePath(router, '/workloads/pods/default/web-1/shell')).toBe('/workloads/pods/default/web-1');
    });

    it('keeps a pod whose name is “shell”, which is not a tab', () => {
        expect(linkablePath(router, '/workloads/pods/default/shell')).toBe('/workloads/pods/default/shell');
    });

    it.each([
        ['a screen no route has', '/workloads/nope'],
        ['a detail missing its name', '/workloads/pods/default'],
        ['more segments than the screen has', '/workloads/pods/default/web-1/logs/extra'],
        ['segments past a screen with none', '/settings/advanced'],
    ])('opens nothing for %s', (_name, path) => {
        expect(linkablePath(router, path)).toBeNull();
    });
});

describe('planDeepLink', () => {
    const scope = {
        current: { name: 'dev', server: DEV },
        contexts: [
            { name: 'dev', server: DEV },
            { name: 'prod-admin', server: PROD },
            { name: 'prod-readonly', server: PROD },
            { name: 'broken', server: 'https://gone.example.com', problem: 'Context “broken” names user “x”.' },
        ],
    };
    const same = (path: string) => path;

    it('navigates straight away when the current context reaches that cluster', () => {
        expect(planDeepLink({ ok: true, server: DEV, path: '/workloads/pods' }, scope, same)).toEqual({
            kind: 'navigate',
            path: '/workloads/pods',
        });
    });

    it('asks first, offering every context that reaches the cluster, whatever each is called', () => {
        expect(planDeepLink({ ok: true, server: PROD, path: '/workloads/pods' }, scope, same)).toEqual({
            kind: 'confirm',
            from: 'dev',
            server: PROD,
            candidates: ['prod-admin', 'prod-readonly'],
            path: '/workloads/pods',
        });
    });

    it('switches to nothing when no context reaches the cluster', () => {
        expect(planDeepLink({ ok: true, server: 'https://elsewhere.example.com', path: '/' }, scope, same)).toEqual({
            kind: 'missingCluster',
            server: 'https://elsewhere.example.com',
        });
    });

    it('offers no context the kubeconfig cannot use', () => {
        expect(planDeepLink({ ok: true, server: 'https://gone.example.com', path: '/' }, scope, same).kind).toBe(
            'missingCluster',
        );
    });

    it('refuses an unknown path before looking at the cluster at all', () => {
        const plan = planDeepLink(
            { ok: true, server: 'https://elsewhere.example.com', path: '/nope' },
            scope,
            () => null,
        );
        expect(plan.kind).toBe('refused');
    });

    it('passes main’s refusal on as it is', () => {
        expect(planDeepLink({ ok: false, reason: 'Not a link.' }, scope, same)).toEqual({
            kind: 'refused',
            message: 'Not a link.',
        });
    });
});

describe('copyablePath', () => {
    it('copies the screen and tab as they are', () => {
        expect(copyablePath('/workloads/pods/default/web-1/logs', 'logs')).toBe('/workloads/pods/default/web-1/logs');
        expect(copyablePath('/workloads/pods/default/web-1', undefined)).toBe('/workloads/pods/default/web-1');
    });

    it('copies a Shell tab as the object’s first tab', () => {
        expect(copyablePath('/workloads/pods/default/web-1/shell', 'shell')).toBe('/workloads/pods/default/web-1');
    });
});

describe('opening a link', () => {
    beforeEach(() => {
        held = null;
        invoke.mockReset();
        invoke.mockImplementation(answer);
        toasts.success.mockReset();
        toasts.error.mockReset();
    });

    it('opens a link for the current context without asking', async () => {
        held = { ok: true, server: DEV, path: '/workloads/deployments' };
        const { router } = renderRoutes(routeTree, '/workloads/pods');
        await waitFor(() => expect(router.state.location.pathname).toBe('/workloads/deployments'));
        expect(screen.queryByTestId('deep-link-confirm')).toBeNull();
        expect(setCalls()).toHaveLength(0);
    });

    it('takes a link again when main pushes that one is waiting', async () => {
        const { router } = renderRoutes(routeTree, '/workloads/pods');
        await waitFor(() => expect(pushes.has('deep-link')).toBe(true));
        held = { ok: true, server: DEV, path: '/workloads/pods/default/web-1/shell' };
        act(() => pushes.get('deep-link')!({}));
        // The Shell tab execs into the pod, so the link opens the pod's first tab instead.
        await waitFor(() => expect(router.state.location.pathname).toBe('/workloads/pods/default/web-1'));
    });

    it('asks before switching to the context that reaches the cluster, naming both, and switches only on yes', async () => {
        held = { ok: true, server: PROD, path: '/workloads/deployments' };
        const { router } = renderRoutes(routeTree, '/workloads/pods');
        const dialog = await screen.findByTestId('deep-link-confirm');
        expect(dialog).toHaveTextContent('“prod-admin”');
        expect(dialog).toHaveTextContent('“dev”');
        expect(dialog).toHaveTextContent(PROD);
        expect(setCalls()).toHaveLength(0);
        await userEvent.click(within(dialog).getByRole('button', { name: 'Switch and open' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/workloads/deployments'));
        expect(setCalls()).toEqual([['context.set', { name: 'prod-admin' }]]);
    });

    it('lets the reader choose when several contexts reach the cluster', async () => {
        data['contexts.list'] = [context('dev', DEV), context('prod-admin', PROD), context('prod-readonly', PROD)];
        try {
            held = { ok: true, server: PROD, path: '/workloads/deployments' };
            const { router } = renderRoutes(routeTree, '/workloads/pods');
            const dialog = await screen.findByTestId('deep-link-confirm');
            await userEvent.click(within(dialog).getByRole('combobox', { name: 'Context' }));
            await userEvent.click(await screen.findByRole('option', { name: 'prod-readonly' }));
            await userEvent.click(within(dialog).getByRole('button', { name: 'Switch and open' }));
            await waitFor(() => expect(router.state.location.pathname).toBe('/workloads/deployments'));
            expect(setCalls()).toEqual([['context.set', { name: 'prod-readonly' }]]);
        } finally {
            data['contexts.list'] = [context('dev', DEV), context('prod-admin', PROD)];
        }
    });

    it('switches nothing and stays put when the answer is no', async () => {
        held = { ok: true, server: PROD, path: '/workloads/deployments' };
        const { router } = renderRoutes(routeTree, '/workloads/pods');
        const dialog = await screen.findByTestId('deep-link-confirm');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Stay' }));
        await waitFor(() => expect(screen.queryByTestId('deep-link-confirm')).toBeNull());
        expect(setCalls()).toHaveLength(0);
        expect(router.state.location.pathname).toBe('/workloads/pods');
    });

    it('says so when no context reaches the cluster, naming its server, and switches nothing', async () => {
        held = { ok: true, server: 'https://staging.example.com', path: '/workloads/deployments' };
        const { router } = renderRoutes(routeTree, '/workloads/pods');
        await waitFor(() =>
            expect(toasts.error).toHaveBeenCalledWith(
                'No context for that cluster',
                expect.objectContaining({ description: expect.stringContaining('https://staging.example.com') }),
            ),
        );
        expect(setCalls()).toHaveLength(0);
        expect(router.state.location.pathname).toBe('/workloads/pods');
    });

    it('says so for a path no screen has', async () => {
        held = { ok: true, server: DEV, path: '/workloads/nope' };
        const { router } = renderRoutes(routeTree, '/workloads/pods');
        await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('That link cannot be opened', expect.anything()));
        expect(router.state.location.pathname).toBe('/workloads/pods');
    });

    it('says why main refused a link', async () => {
        held = { ok: false, reason: 'That is not a Kubermeister link.' };
        renderRoutes(routeTree, '/workloads/pods');
        await waitFor(() =>
            expect(toasts.error).toHaveBeenCalledWith('That link cannot be opened', {
                description: 'That is not a Kubermeister link.',
            }),
        );
    });
});
