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

const context = (name: string) => ({ name, cluster: name, user: name, current: false });

/** The link main is holding, answered once as `deepLink.take` does. */
let held: DeepLink | null = null;

const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'settings.get': settingsFixture(),
    'contexts.list': [context('dev'), context('prod')],
    'context.current': context('dev'),
    'context.set': context('prod'),
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
    const scope = { current: 'dev', contexts: ['dev', 'prod'] };
    const same = (path: string) => path;

    it('navigates straight away under the current context', () => {
        expect(planDeepLink({ ok: true, context: 'dev', path: '/workloads/pods' }, scope, same)).toEqual({
            kind: 'navigate',
            path: '/workloads/pods',
        });
    });

    it('asks first for another context the kubeconfig has, naming both', () => {
        expect(planDeepLink({ ok: true, context: 'prod', path: '/workloads/pods' }, scope, same)).toEqual({
            kind: 'confirm',
            from: 'dev',
            to: 'prod',
            path: '/workloads/pods',
        });
    });

    it('switches to nothing for a context the kubeconfig lacks', () => {
        expect(planDeepLink({ ok: true, context: 'staging', path: '/' }, scope, same)).toEqual({
            kind: 'missingContext',
            context: 'staging',
        });
    });

    it('refuses an unknown path before looking at the context at all', () => {
        const plan = planDeepLink({ ok: true, context: 'staging', path: '/nope' }, scope, () => null);
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
        held = { ok: true, context: 'dev', path: '/workloads/deployments' };
        const { router } = renderRoutes(routeTree, '/workloads/pods');
        await waitFor(() => expect(router.state.location.pathname).toBe('/workloads/deployments'));
        expect(screen.queryByTestId('deep-link-confirm')).toBeNull();
        expect(setCalls()).toHaveLength(0);
    });

    it('takes a link again when main pushes that one is waiting', async () => {
        const { router } = renderRoutes(routeTree, '/workloads/pods');
        await waitFor(() => expect(pushes.has('deep-link')).toBe(true));
        held = { ok: true, context: 'dev', path: '/workloads/pods/default/web-1/shell' };
        act(() => pushes.get('deep-link')!({}));
        // The Shell tab execs into the pod, so the link opens the pod's first tab instead.
        await waitFor(() => expect(router.state.location.pathname).toBe('/workloads/pods/default/web-1'));
    });

    it('asks before switching to another context, naming both, and switches only on yes', async () => {
        held = { ok: true, context: 'prod', path: '/workloads/deployments' };
        const { router } = renderRoutes(routeTree, '/workloads/pods');
        const dialog = await screen.findByTestId('deep-link-confirm');
        expect(dialog).toHaveTextContent('“prod”');
        expect(dialog).toHaveTextContent('“dev”');
        expect(setCalls()).toHaveLength(0);
        await userEvent.click(within(dialog).getByRole('button', { name: 'Switch and open' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/workloads/deployments'));
        expect(setCalls()).toEqual([['context.set', { name: 'prod' }]]);
    });

    it('switches nothing and stays put when the answer is no', async () => {
        held = { ok: true, context: 'prod', path: '/workloads/deployments' };
        const { router } = renderRoutes(routeTree, '/workloads/pods');
        const dialog = await screen.findByTestId('deep-link-confirm');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Stay' }));
        await waitFor(() => expect(screen.queryByTestId('deep-link-confirm')).toBeNull());
        expect(setCalls()).toHaveLength(0);
        expect(router.state.location.pathname).toBe('/workloads/pods');
    });

    it('says so when the kubeconfig has no such context, and switches nothing', async () => {
        held = { ok: true, context: 'staging', path: '/workloads/deployments' };
        const { router } = renderRoutes(routeTree, '/workloads/pods');
        await waitFor(() =>
            expect(toasts.error).toHaveBeenCalledWith(
                'Context not in your kubeconfig',
                expect.objectContaining({ description: expect.stringContaining('“staging”') }),
            ),
        );
        expect(setCalls()).toHaveLength(0);
        expect(router.state.location.pathname).toBe('/workloads/pods');
    });

    it('says so for a path no screen has', async () => {
        held = { ok: true, context: 'dev', path: '/workloads/nope' };
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
