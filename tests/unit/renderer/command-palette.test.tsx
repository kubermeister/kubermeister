import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoutes } from './helpers';
import { settingsFixture } from './settings-fixture';

const invoke = vi.fn();
const subscribe = vi.fn(() => () => {});
const stream = vi.fn(() => ({ stop: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    subscribe,
    stream,
}));

const { routeTree } = await import('@/routeTree.gen');

const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'settings.get': settingsFixture({ updates: { mode: 'check' } }),
    'chartRepositories.list': [],
    'update.check': { status: 'checking' },
    'contexts.list': [
        { name: 'alpha', cluster: 'a', user: 'u', current: true },
        { name: 'beta', cluster: 'b', user: 'u', current: false },
    ],
    'namespaces.list': [
        { name: 'team-a', tone: 'accent' },
        { name: 'kube-system', tone: 'ok' },
    ],
    'namespace.active': { name: 'team-a' },
    'cluster.active': null,
    'nodes.list': [],
    'namespaces.list_': [],
    'events.recent': [],
    'metrics.alerts': [],
    'metrics.sparklines': { nodes: [], cpu: [], mem: [] },
    'metrics.workloadHealth': [],
    'resources.list': { kind: 'Pod', items: [] },
    'context.set': undefined,
    'namespace.set': undefined,
};

describe('command palette', () => {
    beforeEach(() => {
        invoke.mockReset();
        invoke.mockImplementation(async (channel: string) => data[channel]);
    });

    it('opens from the sidebar button and from the keyboard, and closes again', async () => {
        renderRoutes(routeTree, '/overview/summary');
        await userEvent.click(await screen.findByTestId('quick-actions'));
        const dialog = await screen.findByRole('dialog', { name: 'Quick actions' });
        expect(within(dialog).getByPlaceholderText('Switch cluster, namespace or resource…')).toBeInTheDocument();
        await userEvent.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        await userEvent.keyboard('{Control>}k{/Control}');
        expect(await screen.findByRole('dialog', { name: 'Quick actions' })).toBeInTheDocument();
        await userEvent.keyboard('{Control>}k{/Control}');
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('lists contexts, namespaces, the create action and every screen', async () => {
        renderRoutes(routeTree, '/overview/summary');
        await userEvent.keyboard('{Control>}k{/Control}');
        const dialog = await screen.findByRole('dialog', { name: 'Quick actions' });
        await waitFor(() => expect(within(dialog).getByRole('option', { name: /beta/ })).toBeInTheDocument());
        expect(within(dialog).getByRole('option', { name: /kube-system/ })).not.toHaveTextContent('pods');
        for (const label of ['Cluster summary', 'Nodes', 'Namespaces', 'Pods', 'Jobs', 'Autoscalers', 'Settings']) {
            expect(within(dialog).getByRole('option', { name: label })).toBeInTheDocument();
        }
        // Choosing an action closes the palette, so this goes last.
        await userEvent.click(within(dialog).getByRole('option', { name: /Create resource/ }));
        expect(await screen.findByTestId('create-page')).toBeInTheDocument();
    });

    // The labels carry spaces the API spelling has not, so searching for "networkpolicies" must still land.
    it('finds a screen typed the way kubectl spells the kind', async () => {
        renderRoutes(routeTree, '/overview/summary');
        await userEvent.keyboard('{Control>}k{/Control}');
        const dialog = await screen.findByRole('dialog', { name: 'Quick actions' });
        await userEvent.type(
            within(dialog).getByPlaceholderText('Switch cluster, namespace or resource…'),
            'networkpolicies',
        );
        expect(await within(dialog).findByRole('option', { name: 'Network Policies' })).toBeInTheDocument();
    });

    it('starts an update check and opens Settings, where the outcome shows', async () => {
        const { router } = renderRoutes(routeTree, '/overview/summary');
        await userEvent.keyboard('{Control>}k{/Control}');
        const dialog = await screen.findByRole('dialog', { name: 'Quick actions' });
        await userEvent.click(within(dialog).getByRole('option', { name: /Check for updates/ }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('update.check', {}));
        await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('switches context and namespace through the bridge and closes', async () => {
        renderRoutes(routeTree, '/overview/summary');
        await userEvent.keyboard('{Control>}k{/Control}');
        const dialog = await screen.findByRole('dialog', { name: 'Quick actions' });
        await userEvent.click(await within(dialog).findByRole('option', { name: /beta/ }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('context.set', { name: 'beta' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

        await userEvent.keyboard('{Control>}k{/Control}');
        const again = await screen.findByRole('dialog', { name: 'Quick actions' });
        await userEvent.click(await within(again).findByRole('option', { name: /kube-system/ }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('namespace.set', { namespace: 'kube-system' }));
    });

    it('closes a detail page back to its list when the context or namespace changes', async () => {
        const { router } = renderRoutes(routeTree, '/workloads/pods/team-a/web-1');
        await userEvent.keyboard('{Control>}k{/Control}');
        const dialog = await screen.findByRole('dialog', { name: 'Quick actions' });
        await userEvent.click(await within(dialog).findByRole('option', { name: /kube-system/ }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/workloads/pods'));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('namespace.set', { namespace: 'kube-system' }));

        await router.navigate({
            to: '/workloads/pods/$namespace/$name',
            params: { namespace: 'team-a', name: 'web-1' },
        });
        await waitFor(() => expect(router.state.location.pathname).toBe('/workloads/pods/team-a/web-1'));
        await userEvent.keyboard('{Control>}k{/Control}');
        const again = await screen.findByRole('dialog', { name: 'Quick actions' });
        await userEvent.click(await within(again).findByRole('option', { name: /beta/ }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/workloads/pods'));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('context.set', { name: 'beta' }));
    });

    it('marks the namespaces group as loading until the list arrives', async () => {
        invoke.mockImplementation((channel: string) =>
            channel === 'namespaces.list' ? new Promise<never>(() => {}) : Promise.resolve(data[channel]),
        );
        renderRoutes(routeTree, '/overview/summary');
        await userEvent.keyboard('{Control>}k{/Control}');
        const dialog = await screen.findByRole('dialog', { name: 'Quick actions' });
        expect(await within(dialog).findByRole('progressbar', { name: 'Loading namespaces' })).toBeInTheDocument();
        expect(within(dialog).queryByRole('option', { name: /kube-system/ })).not.toBeInTheDocument();
    });

    it('filters and navigates to a screen', async () => {
        const { router } = renderRoutes(routeTree, '/overview/summary');
        await userEvent.keyboard('{Control>}k{/Control}');
        const dialog = await screen.findByRole('dialog', { name: 'Quick actions' });
        const all = within(dialog).getAllByRole('option').length;
        await userEvent.type(within(dialog).getByPlaceholderText('Switch cluster, namespace or resource…'), 'nodes');
        // The filter scores rather than matches exactly, so it narrows the list; Nodes survives it.
        await waitFor(() => expect(within(dialog).getAllByRole('option').length).toBeLessThan(all));
        await userEvent.click(within(dialog).getByRole('option', { name: 'Nodes' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/overview/nodes'));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
});
