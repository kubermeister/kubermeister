import { screen, within } from '@testing-library/react';
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
const meta = {
    owner: {
        apiVersion: 'apps/v1',
        kind: 'ReplicaSet',
        name: 'web-7d9',
        namespace: 'team-a',
        path: '/workloads/replicasets/team-a/web-7d9',
    },
    finalizers: ['kubernetes.io/pvc-protection'],
    deleting: true,
    created: '2026-09-14T10:00:00.000Z',
    uid: 'u1',
};
const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'context.current': { name: 'alpha', cluster: 'a', user: 'u', current: true },
    'namespaces.list': [{ name: 'team-a', tone: 'accent' }],
    'namespace.active': { name: 'team-a' },
    'cluster.active': null,
    'events.forObject': [],
    'metrics.podSeries': { cpu: [], mem: [] },
    'pods.owners': [],
    'resources.list': { kind: 'Pod', items: [pod] },
    'resources.get': {
        kind: 'Pod',
        item: { ...pod, labels: [['app', 'web']], annotations: [], containers: [], conditions: [] },
    },
    'resources.meta': meta,
};

beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (channel: string) => data[channel]);
});

describe('owner and finalizers on every detail', () => {
    it('shows what put the object here and what is holding it open', async () => {
        renderRoutes(routeTree, '/workloads/pods/team-a/web-1');
        const page = await screen.findByTestId('pod-page');
        await userEvent.click(await within(page).findByRole('tab', { name: /Labels/ }));
        const card = await within(page).findByTestId('object-meta');
        expect(invoke).toHaveBeenCalledWith('resources.meta', { kind: 'Pod', name: 'web-1', namespace: 'team-a' });
        expect(within(card).getByRole('link', { name: 'ReplicaSet/web-7d9' })).toHaveAttribute(
            'href',
            '/workloads/replicasets/team-a/web-7d9',
        );
        expect(card).toHaveTextContent('kubernetes.io/pvc-protection');
        // A deletion already under way is when finalizers stop being trivia.
        expect(within(card).getByTestId('held-open')).toBeInTheDocument();
        expect(card).toHaveTextContent('2026-09-14T10:00:00.000Z');
    });
});
