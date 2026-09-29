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

const node = {
    name: 'n1',
    status: 'Cordoned',
    role: 'control-plane',
    version: 'v1.36.4+k3s1',
    cpu: 4,
    memory: 7.8,
    cpuUsed: 25,
    memUsed: 50,
    pods: 12,
    age: '3d',
    instanceType: 'k3s',
    conditions: [
        { type: 'Ready', status: 'True', reason: 'KubeletReady' },
        { type: 'MemoryPressure', status: 'False' },
    ],
    info: {
        os: 'K3s v1.36.4',
        kernel: '6.6.0',
        containerRuntime: 'containerd://2.0',
        kubeletVersion: 'v1.36.4+k3s1',
        architecture: 'arm64',
    },
    labels: [['node-role.kubernetes.io/control-plane', 'true']],
    annotations: [],
};
const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'namespace.active': { name: 'team-a' },
    'cluster.active': { name: 'alpha', nodes: 1, status: 'Healthy', version: '1.36.4', provider: 'k3s', region: '—' },
    'nodes.list': [node],
    'nodes.get': node,
    'metrics.nodeSeries': { cpu: [10, 25], mem: [40, 50] },
    'events.forObject': [
        { time: '12:00:00', type: 'Warning', reason: 'NodeNotReady', object: 'node/n1', message: 'kubelet stopped' },
    ],
};

describe('node detail', () => {
    beforeEach(() => {
        invoke.mockReset();
        invoke.mockImplementation(async (channel: string) => data[channel]);
    });

    it('renders the header, live metric cards and the rail with counts', async () => {
        renderRoutes(routeTree, '/overview/nodes/n1');
        const page = await screen.findByTestId('node-page');
        await waitFor(() => expect(page).toHaveTextContent('role: control-plane'));
        expect(page).toHaveTextContent('k8s v1.36.4+k3s1');
        expect(page).toHaveTextContent('12 pods');
        expect(within(page).getByText('Cordoned', { selector: '[data-tone]' })).toHaveAttribute('data-tone', 'warn');
        expect(invoke).toHaveBeenCalledWith('nodes.get', { name: 'n1' });
        expect(invoke).toHaveBeenCalledWith('metrics.nodeSeries', { name: 'n1' });
        await waitFor(() => expect(page).toHaveTextContent('25%'));
        expect(page).toHaveTextContent('4 cores');
        expect(page).toHaveTextContent('50%');
        expect(page).toHaveTextContent('7.8 GiB');
        expect(page).toHaveTextContent('running');
        const rail = within(page).getByRole('tablist');
        expect(
            within(rail)
                .getAllByRole('tab')
                .map((t) => t.textContent),
        ).toEqual(['Overview', 'Events', 'ManifestYAML', 'Describe', 'Labels1', 'System info', 'Conditions2']);
        // This node is cordoned, so the control offers the way back rather than the way in.
        expect(within(page).getByRole('button', { name: 'Uncordon' })).toBeEnabled();
        expect(within(page).getByRole('button', { name: 'Drain' })).toBeEnabled();
    });

    it('shows system info, conditions, labels and events in their tabs', async () => {
        renderRoutes(routeTree, '/overview/nodes/n1');
        const page = await screen.findByTestId('node-page');
        await userEvent.click(await within(page).findByRole('tab', { name: 'System info' }));
        const info = within(page).getByTestId('system-info');
        expect(info).toHaveTextContent('containerd://2.0');
        expect(info).toHaveTextContent('arm64');
        expect(info).toHaveTextContent('k3s');
        await userEvent.click(within(page).getByRole('tab', { name: /Conditions/ }));
        const conditions = within(page).getByTestId('node-conditions');
        expect(conditions).toHaveTextContent('Ready: True');
        expect(conditions).toHaveTextContent('MemoryPressure: False');
        await userEvent.click(within(page).getByRole('tab', { name: /Labels/ }));
        expect(page).toHaveTextContent('node-role.kubernetes.io/control-plane');
        expect(page).toHaveTextContent('None.');
        await userEvent.click(within(page).getByRole('tab', { name: 'Events' }));
        expect(await within(page).findByText('NodeNotReady')).toBeInTheDocument();
        expect(invoke).toHaveBeenCalledWith('events.forObject', { kind: 'Node', name: 'n1' });
    });

    it('renders dashes without series and not-found for an unknown node', async () => {
        invoke.mockImplementation(async (channel: string) =>
            channel === 'metrics.nodeSeries' ? { cpu: [], mem: [] } : channel === 'nodes.get' ? null : data[channel],
        );
        renderRoutes(routeTree, '/overview/nodes/ghost');
        expect(await screen.findByTestId('not-found')).toHaveTextContent('Node “ghost” was not found.');
        expect(screen.getByRole('link', { name: 'Back to list' })).toHaveAttribute('href', '/overview/nodes');
    });

    it('links each node row to its detail', async () => {
        renderRoutes(routeTree, '/overview/nodes');
        const table = await screen.findByTestId('nodes-table');
        expect(within(table).getByRole('link', { name: 'n1' })).toHaveAttribute('href', '/overview/nodes/n1');
        expect(table.querySelector('[data-node="n1"]')).not.toBeNull();
    });
});
