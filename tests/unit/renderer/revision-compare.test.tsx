import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoutes, renderWithQuery } from './helpers';

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
const { RevisionCompare } = await import('@/components/workload/revision-compare');

const deployment = {
    name: 'web',
    namespace: 'team-a',
    status: 'Healthy',
    ready: '1/1',
    replicas: 1,
    updated: 1,
    available: 1,
    strategy: 'RollingUpdate',
    image: 'nginx:2.0',
    paused: false,
    age: '1h',
    labels: [],
    annotations: [],
};
const rollouts = [
    { rev: '2', state: 'Current', image: 'nginx:2.0', by: '—', when: '1h ago', duration: '1h0m' },
    { rev: '1', state: 'Superseded', image: 'nginx:1.0', by: '—', when: '2h ago', duration: '2h0m' },
];

const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'context.current': { name: 'alpha', cluster: 'a', user: 'u', current: true },
    'namespaces.list': [{ name: 'team-a', tone: 'accent' }],
    'namespace.active': { name: 'team-a' },
    'cluster.active': null,
    'events.forObject': [],
    'metrics.deploymentSeries': { cpu: [], mem: [] },
    'deployments.replicaSets': [],
    'deployments.rollouts': rollouts,
    'deployments.rolloutStatus': null,
    'resources.get': { kind: 'Deployment', item: deployment },
    'resources.meta': { owner: null, finalizers: [], deleting: false, created: '', uid: 'u1' },
    'deployments.compare': {
        from: { rev: '1', yaml: 'spec:\n  containers:\n    - image: nginx:1.0\n' },
        to: { rev: '2', yaml: 'spec:\n  containers:\n    - image: nginx:2.0\n' },
    },
};

beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (channel: string) => data[channel]);
});

describe('comparing two revisions', () => {
    it('opens on the newest against the one before it and shows what changed', async () => {
        renderRoutes(routeTree, '/workloads/deployments/team-a/web');
        const page = await screen.findByTestId('deployment-page');
        await userEvent.click(await within(page).findByRole('tab', { name: /History/ }));

        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('deployments.compare', {
                name: 'web',
                namespace: 'team-a',
                from: '1',
                to: '2',
            }),
        );
        const diff = await within(page).findByTestId('revision-diff');
        expect(diff.querySelector('[data-diff="removed"]')).toHaveTextContent('nginx:1.0');
        expect(diff.querySelector('[data-diff="added"]')).toHaveTextContent('nginx:2.0');
        // The lines both revisions share are shown as context rather than as changes.
        expect(diff.querySelectorAll('[data-diff="same"]').length).toBeGreaterThan(0);
    });

    it('says plainly when two revisions describe the same template', async () => {
        invoke.mockImplementation(async (channel: string) =>
            channel === 'deployments.compare'
                ? { from: { rev: '1', yaml: 'spec: {}\n' }, to: { rev: '2', yaml: 'spec: {}\n' } }
                : data[channel],
        );
        renderRoutes(routeTree, '/workloads/deployments/team-a/web');
        const page = await screen.findByTestId('deployment-page');
        await userEvent.click(await within(page).findByRole('tab', { name: /History/ }));
        await waitFor(() => expect(within(page).getByTestId('revision-diff')).toHaveTextContent('No differences'));
    });

    it('offers nothing to compare when there is only one revision', async () => {
        invoke.mockImplementation(async (channel: string) =>
            channel === 'deployments.rollouts' ? [rollouts[0]] : data[channel],
        );
        renderRoutes(routeTree, '/workloads/deployments/team-a/web');
        const page = await screen.findByTestId('deployment-page');
        await userEvent.click(await within(page).findByRole('tab', { name: /History/ }));
        expect(await within(page).findByTestId('compare-unavailable')).toBeInTheDocument();
        expect(invoke).not.toHaveBeenCalledWith('deployments.compare', expect.anything());
    });
});

describe('revisions that arrive after the compare mounted', () => {
    const three = [
        { rev: '3', state: 'Current', image: 'nginx:3.0', by: '—', when: '1m ago', duration: '1m' },
        ...rollouts.map((r) => ({ ...r, state: 'Superseded' })),
    ];

    it('compares the newest two once the revisions load after the deployment', async () => {
        const view = renderWithQuery(<RevisionCompare name="web" namespace="team-a" rollouts={[]} />);
        view.rerender(<RevisionCompare name="web" namespace="team-a" rollouts={rollouts} />);

        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('deployments.compare', {
                name: 'web',
                namespace: 'team-a',
                from: '1',
                to: '2',
            }),
        );
        expect(screen.getByRole('combobox', { name: 'From revision' })).toHaveTextContent('#1');
        expect(screen.getByRole('combobox', { name: 'To revision' })).toHaveTextContent('#2');
    });

    it('moves off a lone revision when a second one appears', async () => {
        const view = renderWithQuery(<RevisionCompare name="web" namespace="team-a" rollouts={[rollouts[1]!]} />);
        view.rerender(<RevisionCompare name="web" namespace="team-a" rollouts={rollouts} />);

        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('deployments.compare', {
                name: 'web',
                namespace: 'team-a',
                from: '1',
                to: '2',
            }),
        );
        expect(invoke).not.toHaveBeenCalledWith('deployments.compare', expect.objectContaining({ from: '1', to: '1' }));
    });

    it('keeps a revision the reader picked while it is still listed', async () => {
        const view = renderWithQuery(<RevisionCompare name="web" namespace="team-a" rollouts={rollouts} />);
        await userEvent.click(screen.getByRole('combobox', { name: 'To revision' }));
        await userEvent.click(await screen.findByRole('option', { name: '#1' }));
        view.rerender(<RevisionCompare name="web" namespace="team-a" rollouts={three} />);

        expect(screen.getByRole('combobox', { name: 'To revision' })).toHaveTextContent('#1');
        // The side the reader never touched follows the list, as it did when the list first loaded.
        expect(screen.getByRole('combobox', { name: 'From revision' })).toHaveTextContent('#2');
    });

    it('falls back to the default for a picked revision that is no longer listed', async () => {
        const view = renderWithQuery(<RevisionCompare name="web" namespace="team-a" rollouts={three} />);
        await userEvent.click(screen.getByRole('combobox', { name: 'From revision' }));
        await userEvent.click(await screen.findByRole('option', { name: '#1' }));
        view.rerender(<RevisionCompare name="web" namespace="team-a" rollouts={three.slice(0, 2)} />);

        expect(screen.getByRole('combobox', { name: 'From revision' })).toHaveTextContent('#2');
        expect(screen.getByRole('combobox', { name: 'To revision' })).toHaveTextContent('#3');
    });
});
