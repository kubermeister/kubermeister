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

const deployment = {
    name: 'web',
    namespace: 'team-a',
    status: 'Progressing',
    ready: '2/3',
    replicas: 3,
    updated: 3,
    available: 2,
    strategy: 'Recreate',
    image: 'nginx:1.27',
    paused: false,
    age: '3d',
};
const statefulSet = {
    name: 'db',
    namespace: 'team-a',
    ready: '2/2',
    replicas: 2,
    service: 'db-headless',
    image: 'postgres:16',
    age: '1h',
};
const daemonSet = {
    name: 'agent',
    namespace: 'kube-system',
    desired: 3,
    current: 3,
    ready: 2,
    upToDate: 3,
    nodeSelector: 'kubernetes.io/os=linux',
    age: '2h',
};
const meta = { labels: [['app', 'web']], annotations: [] };

const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'context.current': { name: 'alpha', cluster: 'a', user: 'u', current: true },
    'namespaces.list': [{ name: 'team-a', tone: 'accent' }],
    'namespace.active': { name: 'team-a' },
    'cluster.active': null,
    'events.forObject': [],
    'deployments.rollouts': [
        { rev: '2', state: 'Current', image: 'nginx:1.27', by: 'upgrade', when: '1h ago', duration: '1h' },
        { rev: '1', state: 'Superseded', image: 'nginx:1.26', by: '—', when: '3d ago', duration: '3d' },
    ],
    'deployments.replicaSets': [
        { name: 'web-2', desired: 3, current: 3, ready: 3, age: '1h' },
        { name: 'web-1', desired: 0, current: 0, ready: 0, age: '3d' },
    ],
    'metrics.deploymentSeries': { cpu: [100, 250], mem: [10, 20] },
    'workloads.pods': [
        {
            name: 'web-abc-1',
            namespace: 'team-a',
            status: 'Running',
            ready: '1/1',
            restarts: 0,
            age: '2h',
            node: 'n1',
            cpu: 5,
            mem: 12,
            cpuLimit: 0,
            memLimit: 0,
        },
        {
            name: 'web-abc-2',
            namespace: 'team-a',
            status: 'Pending',
            ready: '0/1',
            restarts: 2,
            age: '1m',
            node: 'n1',
            cpu: 0,
            mem: 0,
            cpuLimit: 0,
            memLimit: 0,
        },
    ],
    'deployments.rolloutStatus': {
        paused: false,
        desired: 3,
        updated: 2,
        ready: 2,
        available: 2,
        unavailable: 1,
        settled: false,
        conditions: [
            { type: 'Progressing', status: 'True', reason: 'ReplicaSetUpdated', message: 'rolling', when: '1h ago' },
        ],
        sets: [
            { name: 'web-2', rev: '2', role: 'new', desired: 3, current: 2, ready: 2, age: '2h' },
            { name: 'web-1', rev: '1', role: 'old', desired: 1, current: 1, ready: 1, age: '3h' },
        ],
    },
};

function withResources(
    items: Record<string, unknown[]>,
    details: Record<string, unknown>,
    channels: Record<string, unknown> = data,
) {
    invoke.mockImplementation(async (channel: string, input: { kind?: string }) => {
        if (channel === 'resources.list') return { kind: input.kind, items: items[input.kind!] ?? [] };
        if (channel === 'resources.get') return { kind: input.kind, item: details[input.kind!] ?? null };
        return channels[channel];
    });
}

describe('workload lists', () => {
    beforeEach(() => {
        invoke.mockReset();
        withResources(
            {
                Deployment: [deployment, { ...deployment, name: 'api', status: 'Healthy', ready: '1/1' }],
                StatefulSet: [statefulSet],
                DaemonSet: [daemonSet],
            },
            {
                Deployment: { ...deployment, ...meta },
                StatefulSet: { ...statefulSet, ...meta },
                DaemonSet: { ...daemonSet, ...meta },
            },
        );
    });

    it('lists deployments with ready ratio, status tone and a link to the detail', async () => {
        renderRoutes(routeTree, '/workloads/deployments');
        const table = await screen.findByTestId('deployments-table');
        expect(invoke).toHaveBeenCalledWith('resources.list', { kind: 'Deployment', namespace: undefined });
        const web = table.querySelector('[data-deployment="web"]') as HTMLElement;
        expect(within(web).getByRole('link', { name: 'web' })).toHaveAttribute(
            'href',
            '/workloads/deployments/team-a/web',
        );
        expect(within(web).getByText('2/3')).toHaveClass('text-warn');
        expect(within(web).getByText('Progressing')).toHaveAttribute('data-tone', 'warn');
        expect(web).toHaveTextContent('Recreate');
        expect(web).toHaveTextContent('nginx:1.27');
        const api = table.querySelector('[data-deployment="api"]') as HTMLElement;
        expect(within(api).getByText('1/1')).toHaveClass('text-ok');
        expect(within(api).getByText('Healthy')).toHaveAttribute('data-tone', 'ok');
        expect(stream).toHaveBeenCalledWith(
            'resources.watch',
            { kind: 'Deployment', namespace: undefined },
            expect.any(Function),
        );
    });

    it('lists statefulsets and daemonsets with their columns', async () => {
        renderRoutes(routeTree, '/workloads/statefulsets');
        const sets = await screen.findByTestId('statefulsets-table');
        const db = sets.querySelector('[data-statefulset="db"]') as HTMLElement;
        expect(within(db).getByRole('link', { name: 'db' })).toHaveAttribute(
            'href',
            '/workloads/statefulsets/team-a/db',
        );
        expect(db).toHaveTextContent('db-headless');
        expect(db).toHaveTextContent('postgres:16');

        await userEvent.click(screen.getByRole('link', { name: 'Daemon Sets' }));
        const daemons = await screen.findByTestId('daemonsets-table');
        const agent = daemons.querySelector('[data-daemonset="agent"]') as HTMLElement;
        expect(within(agent).getByRole('link', { name: 'agent' })).toHaveAttribute(
            'href',
            '/workloads/daemonsets/kube-system/agent',
        );
        expect(
            within(daemons)
                .getAllByRole('columnheader')
                .map((h) => h.textContent),
        ).toEqual([
            // The blank leading header belongs to the selection checkbox column.
            '',
            'Name',
            'Desired',
            'Current',
            'Ready',
            'Up-to-date',
            'Node selector',
            'Age',
        ]);
        expect(agent).toHaveTextContent('kubernetes.io/os=linux');
    });
});

describe('workload details', () => {
    beforeEach(() => {
        invoke.mockReset();
        withResources(
            {},
            {
                Deployment: { ...deployment, ...meta },
                StatefulSet: { ...statefulSet, ...meta },
                DaemonSet: { ...daemonSet, ...meta },
            },
        );
    });

    it('renders the deployment header, metric cards, rollout history and replicasets', async () => {
        renderRoutes(routeTree, '/workloads/deployments/team-a/web');
        const page = await screen.findByTestId('deployment-page');
        await waitFor(() => expect(page).toHaveTextContent('replicas: 2/3'));
        expect(page).toHaveTextContent('strategy: Recreate');
        expect(within(page).getByText('Progressing', { selector: '[data-tone]' })).toHaveAttribute('data-tone', 'warn');
        await waitFor(() => expect(page).toHaveTextContent('250m'));
        expect(page).toHaveTextContent('Replicas3');
        expect(page).toHaveTextContent('Available2');
        expect(page).toHaveTextContent('Updated3');
        expect(within(page).getByRole('button', { name: 'Restart' })).toBeEnabled();
        expect(within(page).getByRole('button', { name: 'Scale' })).toBeEnabled();

        const rail = within(page).getByRole('tablist');
        expect(
            within(rail)
                .getAllByRole('tab')
                .map((t) => t.textContent),
        ).toEqual([
            'Overview',
            'Pods',
            'Logs',
            'Events',
            'Status',
            'History2',
            'Replica Sets2',
            'ManifestYAML',
            'Labels1',
        ]);
        await userEvent.click(within(rail).getByRole('tab', { name: /History/ }));
        const history = within(page).getByTestId('rollout-history');
        expect(page).toHaveTextContent('2 revisions');
        const current = history.querySelector('[data-revision="2"]') as HTMLElement;
        expect(within(current).getByText('Current')).toHaveAttribute('data-tone', 'ok');
        expect(within(current).queryByRole('button', { name: 'Roll back' })).not.toBeInTheDocument();
        const superseded = history.querySelector('[data-revision="1"]') as HTMLElement;
        expect(within(superseded).getByText('Superseded')).toHaveAttribute('data-tone', 'neutral');
        expect(within(superseded).getByRole('button', { name: 'Roll back' })).toBeEnabled();
        expect(invoke).toHaveBeenCalledWith('deployments.rollouts', { name: 'web', namespace: 'team-a' });

        await userEvent.click(within(rail).getByRole('tab', { name: /Replica Sets/ }));
        const sets = within(page).getByTestId('replica-sets');
        expect(within(sets).getAllByRole('row')).toHaveLength(3);
        expect(within(sets).getByText('web-2').closest('tr')?.querySelector('.text-ok')).toHaveTextContent('3');
        expect(within(sets).getByText('web-1').closest('tr')?.querySelector('.text-text-muted')).toHaveTextContent('0');
        expect(invoke).toHaveBeenCalledWith('metrics.deploymentSeries', { namespace: 'team-a', name: 'web' });
    });

    it('lists the pods a controller owns, each linking to its own detail', async () => {
        renderRoutes(routeTree, '/workloads/deployments/team-a/web');
        const page = await screen.findByTestId('deployment-page');
        const rail = await within(page).findByRole('tablist');
        await userEvent.click(within(rail).getByRole('tab', { name: 'Pods' }));

        const table = await within(page).findByTestId('owned-pods');
        await waitFor(() => expect(table).toHaveTextContent('web-abc-1'));
        expect(page).toHaveTextContent('2 pods owned by this Deployment');
        const pending = table.querySelector('[data-pod="web-abc-2"]') as HTMLElement;
        expect(within(pending).getByText('Pending')).toHaveAttribute('data-tone', 'warn');
        // Restarts are toned so a crash-looping pod stands out in the controller's own list.
        expect(within(pending).getByText('2')).toHaveClass('text-warn');
        expect(within(table).getByRole('link', { name: 'web-abc-1' })).toHaveAttribute(
            'href',
            expect.stringContaining('/workloads/pods/team-a/web-abc-1'),
        );
        expect(invoke).toHaveBeenCalledWith('workloads.pods', { kind: 'Deployment', name: 'web', namespace: 'team-a' });
    });

    it('says plainly when a controller has no pods', async () => {
        withResources({}, { Deployment: { ...deployment, ...meta } }, { ...data, 'workloads.pods': [] });
        renderRoutes(routeTree, '/workloads/deployments/team-a/web');
        const page = await screen.findByTestId('deployment-page');
        const rail = await within(page).findByRole('tablist');
        await userEvent.click(within(rail).getByRole('tab', { name: 'Pods' }));
        await waitFor(() => expect(page).toHaveTextContent('0 pods owned by this Deployment'));
    });

    it('shows live rollout progress, the controller’s conditions and each generation', async () => {
        renderRoutes(routeTree, '/workloads/deployments/team-a/web');
        const page = await screen.findByTestId('deployment-page');
        const rail = await within(page).findByRole('tablist');
        await userEvent.click(within(rail).getByRole('tab', { name: 'Status' }));

        // Two of three replicas updated: the card reads the share, not the raw counts.
        await waitFor(() => expect(page).toHaveTextContent('67% of replicas updated'));
        // The end-to-end spec reads the rollout state through this card, so it is asserted here too.
        expect(within(page).getByTestId('rollout-progress')).toHaveTextContent('Rolling out');
        expect(within(page).getByText('Rolling out')).toHaveAttribute('data-tone', 'warn');
        expect(within(page).getByRole('progressbar', { name: 'Updated replicas' })).toHaveAttribute(
            'aria-valuenow',
            '67',
        );
        const conditions = within(page).getByTestId('rollout-conditions');
        expect(within(conditions).getByText('ReplicaSetUpdated')).toBeInTheDocument();
        const generations = within(page).getByTestId('rollout-generations');
        expect(within(generations).getByText('New').closest('tr')).toHaveAttribute('data-generation', '2');
        expect(within(generations).getByText('Old').closest('tr')).toHaveAttribute('data-generation', '1');
        expect(invoke).toHaveBeenCalledWith('deployments.rolloutStatus', { name: 'web', namespace: 'team-a' });
    });

    it('reads a scaled-to-zero deployment as fully rolled out, and tolerates an odd condition', async () => {
        withResources(
            {},
            { Deployment: { ...deployment, ...meta } },
            {
                ...data,
                'deployments.rolloutStatus': {
                    paused: false,
                    desired: 0,
                    updated: 0,
                    ready: 0,
                    available: 0,
                    unavailable: 0,
                    settled: true,
                    conditions: [{ type: 'Progressing', status: 'Unknown', reason: '—', message: '—', when: '1h ago' }],
                    sets: [],
                },
            },
        );
        renderRoutes(routeTree, '/workloads/deployments/team-a/web');
        const page = await screen.findByTestId('deployment-page');
        const rail = await within(page).findByRole('tablist');
        await userEvent.click(within(rail).getByRole('tab', { name: 'Status' }));
        await waitFor(() => expect(page).toHaveTextContent('100% of replicas updated'));
        expect(within(page).getByText('Settled')).toHaveAttribute('data-tone', 'ok');
        expect(within(page).getByText('Unknown')).toHaveAttribute('data-tone', 'warn');
    });

    it('shows nothing in the status tab until the rollout read answers', async () => {
        withResources({}, { Deployment: { ...deployment, ...meta } }, { ...data, 'deployments.rolloutStatus': null });
        renderRoutes(routeTree, '/workloads/deployments/team-a/web');
        const page = await screen.findByTestId('deployment-page');
        const rail = await within(page).findByRole('tablist');
        await userEvent.click(within(rail).getByRole('tab', { name: 'Status' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('deployments.rolloutStatus', expect.anything()));
        expect(within(page).queryByTestId('rollout-conditions')).not.toBeInTheDocument();
    });

    it('reads a paused rollout as held, and offers to resume it', async () => {
        withResources(
            {},
            {
                Deployment: { ...deployment, ...meta, status: 'Paused', paused: true },
            },
            {
                ...data,
                'deployments.rolloutStatus': {
                    ...(data['deployments.rolloutStatus'] as object),
                    paused: true,
                },
            },
        );
        renderRoutes(routeTree, '/workloads/deployments/team-a/web');
        const page = await screen.findByTestId('deployment-page');
        await waitFor(() => expect(within(page).getByText('Paused')).toHaveAttribute('data-tone', 'neutral'));
        expect(within(page).getByRole('button', { name: 'Resume' })).toBeInTheDocument();

        await userEvent.click(within(page).getByRole('tab', { name: 'Status' }));
        await waitFor(() => expect(within(page).getByTestId('rollout-progress')).toHaveTextContent('Paused'));
        expect(page).toHaveTextContent('No further change is applied');
    });

    it('renders the statefulset and daemonset overviews and not-found states', async () => {
        renderRoutes(routeTree, '/workloads/statefulsets/team-a/db');
        const page = await screen.findByTestId('statefulset-page');
        await waitFor(() => expect(page).toHaveTextContent('service: db-headless'));
        expect(page).toHaveTextContent('postgres:16');
        expect(within(page).getByRole('tab', { name: /Labels/ })).toHaveTextContent('1');
        expect(within(page).getByRole('button', { name: 'Scale' })).toBeEnabled();

        const { router } = renderRoutes(routeTree, '/workloads/daemonsets/kube-system/agent');
        const daemon = await screen.findByTestId('daemonset-page');
        await waitFor(() => expect(daemon).toHaveTextContent('desired: 3'));
        expect(daemon).toHaveTextContent('Node selector');
        expect(daemon).toHaveTextContent('kubernetes.io/os=linux');

        invoke.mockImplementation(async (channel: string, input: { kind?: string }) =>
            channel === 'resources.get' ? { kind: input.kind, item: null } : data[channel],
        );
        await router.navigate({
            to: '/workloads/daemonsets/$namespace/$name',
            params: { namespace: 'kube-system', name: 'ghost' },
        });
        expect(await screen.findByTestId('not-found')).toHaveTextContent(
            'DaemonSet “ghost” was not found in namespace “kube-system”.',
        );
    });
});
