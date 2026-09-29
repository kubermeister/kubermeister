import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoutes } from './helpers';

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
const { IpcError } = await import('@/lib/ipc');

const pod = (name: string, node: string, owner: string) => ({
    name,
    namespace: 'team-a',
    status: 'Running',
    ready: '1/1',
    restarts: 0,
    age: '1h',
    node,
    owner,
    cpu: 0,
    mem: 0,
    cpuLimit: 0,
    memLimit: 0,
});

const detail = {
    name: 'team-a',
    phase: 'Active',
    age: '3d',
    labels: [['tier', 'app']],
    annotations: [],
    counts: [
        { kind: 'Pod', count: 2, listPath: '/workloads/pods' },
        { kind: 'Secret', count: 0, listPath: '/workloads/secrets' },
    ],
    quotas: [{ namespace: 'team-a', name: 'q', resource: 'pods', used: '3', hard: '10', remaining: '7', usage: 30 }],
    limits: [],
    cpuUsed: 12,
    memUsed: 64,
    cpuRequested: 250,
    memRequested: 128,
};

const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'context.current': { name: 'alpha', cluster: 'a', user: 'u', current: true },
    'namespaces.list': [{ name: 'team-a', tone: 'accent' }],
    'namespace.active': { name: 'team-a' },
    'cluster.active': null,
    'events.forObject': [],
    'namespaces.detail': detail,
    'resources.list': {
        kind: 'Pod',
        items: [pod('web-1', 'n1', 'ReplicaSet/web'), pod('db-0', 'n2', 'StatefulSet/db')],
    },
    'resources.create': { kind: 'Namespace', name: 'team-b' },
};

beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (channel: string) => data[channel]);
});

describe('namespace detail', () => {
    it('rolls up what lives in the namespace, each count linking to that kind', async () => {
        renderRoutes(routeTree, '/overview/namespaces/team-a');
        const page = await screen.findByTestId('namespace-page');
        await waitFor(() => expect(page).toHaveTextContent('phase: Active'));
        expect(invoke).toHaveBeenCalledWith('namespaces.detail', { name: 'team-a' });
        expect(page).toHaveTextContent('12m');
        expect(page).toHaveTextContent('250m requested');

        await userEvent.click(within(page).getByRole('tab', { name: 'Contents' }));
        const counts = await within(page).findByTestId('namespace-counts');
        expect(within(counts).getByRole('link', { name: /Pod/ })).toHaveAttribute('href', '/workloads/pods');
        expect(counts).toHaveTextContent('2');
    });

    it('shows the namespace’s own budgets', async () => {
        renderRoutes(routeTree, '/overview/namespaces/team-a');
        const page = await screen.findByTestId('namespace-page');
        await userEvent.click(await within(page).findByRole('tab', { name: 'Budgets' }));
        const quotas = await within(page).findByTestId('namespace-quotas');
        expect(quotas).toHaveTextContent('3 / 10');
        expect(await within(page).findByTestId('namespace-limits')).toHaveTextContent('no limit range');
    });

    it('opens from the list, which also offers a new namespace', async () => {
        renderRoutes(routeTree, '/overview/namespaces');
        const table = await screen.findByTestId('namespaces-table');
        expect(within(table).getByRole('link', { name: /team-a/ })).toHaveAttribute(
            'href',
            '/overview/namespaces/team-a',
        );

        await userEvent.click(screen.getByTestId('create-namespace'));
        const dialog = await screen.findByRole('alertdialog');
        const create = within(dialog).getByRole('button', { name: 'Create' });
        // An empty or malformed name never reaches the cluster.
        expect(create).toBeDisabled();
        await userEvent.type(within(dialog).getByLabelText('Namespace name'), 'Team B');
        expect(create).toBeDisabled();
        await userEvent.clear(within(dialog).getByLabelText('Namespace name'));
        await userEvent.type(within(dialog).getByLabelText('Namespace name'), 'team-b');
        await userEvent.click(create);
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith(
                'resources.create',
                expect.objectContaining({ manifest: expect.stringContaining('name: team-b') }),
            ),
        );
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    });

    it('keeps the new namespace dialog open when the cluster refuses the name', async () => {
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'resources.create')
                throw new IpcError({
                    kind: 'conflict',
                    detail: 'namespaces "team-a" already exists',
                    op: 'resources.create',
                });
            return data[channel];
        });
        renderRoutes(routeTree, '/overview/namespaces');
        await userEvent.click(await screen.findByTestId('create-namespace'));
        const dialog = await screen.findByRole('alertdialog');
        await userEvent.type(within(dialog).getByLabelText('Namespace name'), 'team-a');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('resources.create', expect.anything()));
        await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Create' })).toBeEnabled());
        expect(screen.getByRole('alertdialog')).toBe(dialog);
        expect(within(dialog).getByLabelText('Namespace name')).toHaveValue('team-a');
    });
});

describe('grouping the pod list', () => {
    it('groups by node or owner, with the rows of a group under one heading', async () => {
        renderRoutes(routeTree, '/workloads/pods');
        const table = await screen.findByTestId('pods-table');
        // Ungrouped to start: the rows carry no headings above them.
        expect(table.querySelectorAll('[data-group]')).toHaveLength(0);

        await userEvent.click(screen.getByRole('combobox', { name: 'Group pods' }));
        await userEvent.click(await screen.findByRole('option', { name: 'By node' }));
        await waitFor(() => expect(table.querySelector('[data-group="n1"]')).toBeInTheDocument());
        expect(table.querySelector('[data-group="n2"]')).toBeInTheDocument();
        expect(table.querySelector('[data-group="n1"]')).toHaveTextContent('1');

        await userEvent.click(screen.getByRole('combobox', { name: 'Group pods' }));
        await userEvent.click(await screen.findByRole('option', { name: 'By owner' }));
        await waitFor(() => expect(table.querySelector('[data-group="ReplicaSet/web"]')).toBeInTheDocument());
        expect(table.querySelector('[data-group="StatefulSet/db"]')).toBeInTheDocument();
    });
});
