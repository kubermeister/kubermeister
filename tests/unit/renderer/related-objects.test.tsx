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

const pod = {
    name: 'web-1',
    namespace: 'team-a',
    status: 'Running',
    ready: '1/1',
    restarts: 0,
    age: '1h',
    node: 'n1',
    owner: 'ReplicaSet/web-7d9',
    cpu: 0,
    mem: 0,
    cpuLimit: 0,
    memLimit: 0,
};

const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'context.current': { name: 'alpha', cluster: 'a', user: 'u', current: true },
    'namespaces.list': [{ name: 'team-a', tone: 'accent' }],
    'namespace.active': { name: 'team-a' },
    'cluster.active': null,
    'settings.get': settingsFixture({ updates: { mode: 'check' } }),
    'metrics.podSeries': { cpu: [], mem: [] },
    'pods.owners': [],
    'events.forObject': [],
    'resources.get': { kind: 'Pod', item: { ...pod, labels: [], annotations: [], containers: [], conditions: [] } },
    'resources.meta': { owner: null, finalizers: [], deleting: false, created: '', uid: 'u1' },
    'resources.related': [
        {
            label: 'Traffic',
            items: [
                {
                    kind: 'Service',
                    name: 'web',
                    namespace: 'team-a',
                    path: '/network/services/team-a/web',
                    why: 'selects these pods',
                },
            ],
        },
        {
            label: 'Configuration',
            items: [
                {
                    kind: 'ConfigMap',
                    name: 'app-config',
                    namespace: 'team-a',
                    path: '/workloads/configmaps/team-a/app-config',
                    why: 'mounted as volume “config”',
                },
            ],
        },
    ],
};

beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (channel: string) => data[channel]);
});

describe('the Related tab', () => {
    it('says what each relation is, not only that one exists', async () => {
        renderRoutes(routeTree, '/workloads/pods/team-a/web-1');
        const page = await screen.findByTestId('pod-page');
        await userEvent.click(await within(page).findByRole('tab', { name: 'Related' }));
        expect(invoke).toHaveBeenCalledWith('resources.related', {
            kind: 'Pod',
            name: 'web-1',
            namespace: 'team-a',
        });

        const traffic = await within(page).findByTestId('related-traffic');
        const service = within(traffic).getByText('web');
        expect(service).toHaveAttribute('href', '/network/services/team-a/web');
        expect(traffic).toHaveTextContent('selects these pods');

        const config = within(page).getByTestId('related-configuration');
        expect(config).toHaveTextContent('mounted as volume “config”');
        expect(within(config).getByText('app-config')).toHaveAttribute(
            'href',
            '/workloads/configmaps/team-a/app-config',
        );
    });

    it('says plainly when nothing else names the object', async () => {
        invoke.mockImplementation(async (channel: string) => (channel === 'resources.related' ? [] : data[channel]));
        renderRoutes(routeTree, '/workloads/pods/team-a/web-1');
        const page = await screen.findByTestId('pod-page');
        await userEvent.click(await within(page).findByRole('tab', { name: 'Related' }));
        await waitFor(() => expect(within(page).getByTestId('related-empty')).toBeInTheDocument());
    });
});
