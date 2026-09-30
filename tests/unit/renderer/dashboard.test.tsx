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

const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'namespace.active': { name: 'team-a' },
    'cluster.active': { name: 'alpha', nodes: 3, status: 'Degraded', version: '1.36.4', provider: 'k3s', region: 'eu' },
    'namespaces.list': [
        { name: 'team-a', tone: 'accent' },
        { name: 'kube-system', tone: 'ok' },
    ],
    'events.recent': [
        {
            time: '12:00:05',
            type: 'Warning',
            reason: 'BackOff',
            object: 'pod/web-1',
            namespace: 'team-a',
            message: 'restarting',
        },
    ],
    'metrics.alerts': [
        { tone: 'danger', title: 'CrashLoopBackOff: web-1', detail: '12 restarts — team-a/web-1' },
        { tone: 'warn', title: 'Node cordoned: n2', detail: 'Scheduling disabled' },
    ],
    'metrics.sparklines': { nodes: [3, 3], cpu: [20, 42], mem: [50, 70] },
    'metrics.workloadHealth': [
        { t: 1, cpu: 20, mem: 50 },
        { t: 2, cpu: 42, mem: 70 },
    ],
};

describe('cluster dashboard', () => {
    beforeEach(() => {
        invoke.mockReset();
        invoke.mockImplementation(async (channel: string) => data[channel]);
    });

    it('renders the header, metric cards, workload health, events and alerts', async () => {
        renderRoutes(routeTree, '/overview/summary');
        const page = await screen.findByTestId('cluster-summary');
        await waitFor(() => expect(within(page).getByTestId('dashboard-metrics')).toBeInTheDocument());
        expect(page).toHaveTextContent('CLUSTER OVERVIEW');
        expect(page).toHaveTextContent('alpha');
        expect(within(page).getByText('Degraded', { selector: '[data-tone]' })).toHaveAttribute('data-tone', 'warn');
        expect(page).toHaveTextContent('k3s · v1.36.4 · eu');

        const metrics = within(page).getByTestId('dashboard-metrics');
        expect(metrics).toHaveTextContent('Nodes3');
        // No pod figure: counting pods means listing them.
        expect(metrics).not.toHaveTextContent('Pods');
        expect(within(metrics).getAllByText(/^(Nodes|CPU usage|Memory)$/)).toHaveLength(3);
        await waitFor(() => expect(metrics).toHaveTextContent('CPU usage42%'));
        expect(metrics).toHaveTextContent('Memory70%');
        expect(metrics.querySelectorAll('svg').length).toBeGreaterThanOrEqual(3);

        const health = within(page).getByTestId('workload-health');
        expect(health).toHaveTextContent('live · ~12s samples');
        expect(health).toHaveTextContent('CPU usage');
        await waitFor(() => expect(health).toHaveTextContent('mem avg 60% / peak 70%'));

        const events = within(page).getByTestId('recent-events');
        expect(within(events).getByRole('list', { name: 'Events' })).toHaveTextContent('BackOff');
        expect(events).toHaveTextContent('pod/web-1');

        const alerts = within(page).getByTestId('alerts');
        expect(within(alerts).getByTestId('alert-count')).toHaveTextContent('2');
        expect(within(alerts).getByTestId('alert-count')).toHaveClass('text-danger');
        const rows = within(alerts).getAllByRole('listitem');
        expect(rows[0]).toHaveAttribute('data-tone', 'danger');
        expect(rows[0]).toHaveTextContent('CrashLoopBackOff: web-1');
        expect(rows[1]).toHaveTextContent('Scheduling disabled');
        expect(within(page).queryByRole('button', { name: 'Deploy' })).toBeNull();
    });

    it('shows empty states and a neutral alert badge, and stays healthy without metrics', async () => {
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'events.recent' || channel === 'metrics.alerts') return [];
            if (channel === 'metrics.sparklines') return { nodes: [], cpu: [], mem: [] };
            if (channel === 'metrics.workloadHealth') throw new Error('no metrics-server');
            return data[channel];
        });
        renderRoutes(routeTree, '/overview/summary');
        const page = await screen.findByTestId('cluster-summary');
        expect(await within(page).findByText('No recent events.')).toBeInTheDocument();
        expect(within(page).getByText('No active alerts.')).toBeInTheDocument();
        expect(within(page).getByTestId('alert-count')).toHaveTextContent('0');
        expect(within(page).getByTestId('alert-count')).not.toHaveClass('text-danger');
        expect(within(page).getByTestId('dashboard-metrics')).toHaveTextContent('CPU usage0%');
        expect(within(page).getByTestId('workload-health')).not.toHaveTextContent('mem avg');
        expect(within(page).queryByTestId('dashboard-error')).not.toBeInTheDocument();
    });

    it('shows skeletons while the core reads are pending', async () => {
        invoke.mockImplementation((channel: string) =>
            channel === 'metrics.alerts' ? new Promise(() => {}) : Promise.resolve(data[channel]),
        );
        renderRoutes(routeTree, '/overview/summary');
        const page = await screen.findByTestId('cluster-summary');
        expect(await within(page).findByRole('status', { name: 'Loading' })).toBeInTheDocument();
        expect(within(page).queryByTestId('dashboard-metrics')).not.toBeInTheDocument();
    });

    it('replaces the body with one error card when a core read fails and retries all reads', async () => {
        const { IpcError } = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
        let fail = true;
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'events.recent' && fail)
                throw new IpcError({ kind: 'forbidden', detail: 'events denied', op: 'events.recent' });
            return data[channel];
        });
        renderRoutes(routeTree, '/overview/summary');
        const error = await screen.findByTestId('dashboard-error');
        expect(error).toHaveTextContent('Access denied');
        expect(error).toHaveTextContent("Couldn't load the cluster overview.");
        // The classified reason travels with the card; a user should never have to guess at it.
        expect(error).toHaveTextContent('events denied');
        fail = false;
        await userEvent.click(within(error).getByRole('button', { name: 'Retry' }));
        expect(await screen.findByTestId('dashboard-metrics')).toBeInTheDocument();
    });

    it('names the ceiling when a core read timed out', async () => {
        const { IpcError } = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'events.recent')
                throw new IpcError({
                    kind: 'timeout',
                    detail: 'The cluster did not answer within 15 s. It may be busy, or the connection slow.',
                    op: 'events.recent',
                });
            return data[channel];
        });
        renderRoutes(routeTree, '/overview/summary');
        const error = await screen.findByTestId('dashboard-error');
        expect(error).toHaveTextContent('Cluster timed out');
        expect(error).toHaveTextContent('did not answer within 15 s');
        const hint = within(error).getByTestId('read-timeout-hint');
        expect(within(hint).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings/data');
        // The summary's reads are cluster-wide by design, so no namespace would narrow them.
        expect(within(error).queryByTestId('all-namespaces-hint')).not.toBeInTheDocument();
    });

    it('hides a detail that only repeats the title', async () => {
        const { IpcError } = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'events.recent')
                throw new IpcError({ kind: 'unreachable', detail: '', op: 'events.recent' });
            return data[channel];
        });
        renderRoutes(routeTree, '/overview/summary');
        const error = await screen.findByTestId('dashboard-error');
        expect(within(error).getAllByText('Cluster unreachable')).toHaveLength(1);
    });

    it('renders the no-cluster header when no context is active', async () => {
        invoke.mockImplementation(async (channel: string) => (channel === 'cluster.active' ? null : data[channel]));
        renderRoutes(routeTree, '/overview/summary');
        const page = await screen.findByTestId('cluster-summary');
        await waitFor(() => expect(page).toHaveTextContent('No cluster connected'));
        expect(within(page).getByTestId('dashboard-metrics')).toHaveTextContent('Nodes0');
    });
});
