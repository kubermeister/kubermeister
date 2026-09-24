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

const toasts = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', async () => ({
    ...(await vi.importActual<typeof import('sonner')>('sonner')),
    toast: toasts,
}));

const { routeTree } = await import('@/routeTree.gen');
const { IpcError } = await import('@/lib/ipc');

const crd = {
    name: 'helmcharts.helm.cattle.io',
    group: 'helm.cattle.io',
    version: 'v1',
    scope: 'Namespaced',
    kind: 'HelmChart',
    age: '3h',
};
const clusterCrd = { ...crd, name: 'addons.k3s.cattle.io', scope: 'Cluster', kind: 'Addon' };
const release = {
    name: 'traefik',
    namespace: 'kube-system',
    chart: 'traefik-28.0.0',
    revision: 2,
    status: 'Deployed',
    updated: '1h ago',
    values: 'service:\n  type: LoadBalancer\n',
    manifest: '# Source: traefik/templates/service.yaml\napiVersion: v1\nkind: Service\n',
};
const chart = {
    name: 'traefik',
    repository: '—',
    latestVersion: '28.0.0',
    appVersion: '3.0.0',
    description: 'Upgrade complete',
};
const revisions = [
    { rev: '2', status: 'Deployed', chartVersion: '28.0.0', updated: '1h ago', description: 'Upgrade complete' },
    { rev: '1', status: 'Superseded', chartVersion: '27.0.0', updated: '2h ago', description: 'Install complete' },
];
const releaseObjects = [
    {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name: 'traefik',
        namespace: 'kube-system',
        state: 'Present',
        status: { kind: 'Deployment', value: 'Healthy' },
        path: '/workloads/deployments/kube-system/traefik',
    },
    {
        apiVersion: 'v1',
        kind: 'Service',
        name: 'traefik',
        namespace: 'kube-system',
        state: 'Missing',
        status: null,
        path: null,
    },
    {
        apiVersion: 'traefik.io/v1alpha1',
        kind: 'IngressRoute',
        name: 'dashboard',
        namespace: 'kube-system',
        state: 'Present',
        status: null,
        path: null,
    },
];
const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'context.current': { name: 'alpha', cluster: 'a', user: 'u', current: true },
    'namespaces.list': [{ name: 'kube-system', tone: 'accent' }],
    'namespace.active': { name: 'kube-system' },
    'cluster.active': null,
    'events.forObject': [],
    'releases.list': [release],
    'releases.get': release,
    'releases.revisions': revisions,
    'releases.resources': releaseObjects,
    'helmCharts.list': [chart],
    'releases.rollback': { name: 'traefik', namespace: 'kube-system', revision: 3, removed: 1, kept: 0 },
    'releases.uninstall': { name: 'traefik', namespace: 'kube-system', removed: 4, kept: 1 },
};

beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (channel: string, input: { kind?: string }) => {
        if (channel === 'resources.list') return { kind: input.kind, items: [crd, clusterCrd] };
        if (channel === 'resources.get') return { kind: input.kind, item: { ...crd, labels: [], annotations: [] } };
        return data[channel];
    });
});

describe('add-on lists', () => {
    it('lists the charts derived from the installed releases', async () => {
        renderRoutes(routeTree, '/addons/charts');
        const table = await screen.findByTestId('charts-table');
        const row = table.querySelector('[data-chart="traefik"]') as HTMLElement;
        expect(row).toHaveTextContent('28.0.0');
        expect(row).toHaveTextContent('3.0.0');
        expect(row).toHaveTextContent('Upgrade complete');
    });

    it('lists releases with a toned status and definitions marking the cluster-scoped ones', async () => {
        renderRoutes(routeTree, '/addons/releases');
        const releases = await screen.findByTestId('releases-table');
        const releaseRow = releases.querySelector('[data-release="traefik"]') as HTMLElement;
        expect(within(releaseRow).getByText('Deployed')).toHaveAttribute('data-tone', 'ok');
        expect(within(releaseRow).getByRole('link', { name: 'traefik' })).toHaveAttribute(
            'href',
            '/addons/releases/kube-system/traefik',
        );

        await userEvent.click(screen.getByRole('link', { name: 'CRDs' }));
        const crds = await screen.findByTestId('crds-table');
        expect(crds.querySelector('[data-crd="helmcharts.helm.cattle.io"]')).toHaveTextContent('HelmChart');
        expect(crds.querySelector('[data-crd="addons.k3s.cattle.io"]')).toHaveTextContent('Cluster');
    });
});

describe('add-on details', () => {
    it('shows a release with its revision history and user-supplied values', async () => {
        renderRoutes(routeTree, '/addons/releases/kube-system/traefik/revisions');
        const page = await screen.findByTestId('release-page');
        await waitFor(() => expect(page).toHaveTextContent('chart: traefik-28.0.0'));
        expect(page).toHaveTextContent('revision: 2');
        const history = within(page).getByTestId('release-revisions');
        expect(history).toHaveTextContent('#2');
        expect(history).toHaveTextContent('Install complete');

        await userEvent.click(within(page).getByRole('tab', { name: /Values/ }));
        expect(within(page).getByTestId('release-values')).toHaveTextContent('type: LoadBalancer');
    });

    it('opens on the objects the release rendered, naming the one that breaks it', async () => {
        renderRoutes(routeTree, '/addons/releases/kube-system/traefik');
        const page = await screen.findByTestId('release-page');
        const table = await within(page).findByTestId('release-resources');
        expect(invoke).toHaveBeenCalledWith('releases.resources', { name: 'traefik', namespace: 'kube-system' });

        const health = within(page).getByTestId('release-health');
        expect(health).toHaveAttribute('data-health', 'Failing');
        expect(health).toHaveTextContent('Service traefik is Missing.');

        const deployment = table.querySelector('[data-object="Deployment/traefik"]') as HTMLElement;
        expect(deployment).toHaveTextContent('Healthy');
        expect(within(deployment).getByRole('link', { name: 'traefik' })).toHaveAttribute(
            'href',
            '/workloads/deployments/kube-system/traefik',
        );
        const service = table.querySelector('[data-object="Service/traefik"]') as HTMLElement;
        expect(service).toHaveAttribute('data-worst', 'true');
        expect(within(service).getByText('Missing')).toBeInTheDocument();
        expect(within(service).queryByRole('link')).not.toBeInTheDocument();
        // A custom resource the registry has no screen for is named, and read as merely present.
        const route = table.querySelector('[data-object="IngressRoute/dashboard"]') as HTMLElement;
        expect(route).toHaveTextContent('Present');
        expect(within(route).queryByRole('link')).not.toBeInTheDocument();
    });

    it('says why the objects could not be read', async () => {
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'releases.resources') {
                return Promise.reject(
                    new IpcError({ kind: 'timeout', detail: 'The cluster did not answer.', op: 'releases.resources' }),
                );
            }
            return data[channel];
        });
        renderRoutes(routeTree, '/addons/releases/kube-system/traefik');
        const page = await screen.findByTestId('release-page');
        await waitFor(() =>
            expect(within(page).getByTestId('release-resources-state')).toHaveTextContent(
                'The cluster did not answer.',
            ),
        );
    });

    it('rolls back to an older revision, and offers no rollback for the one running', async () => {
        renderRoutes(routeTree, '/addons/releases/kube-system/traefik/revisions');
        const page = await screen.findByTestId('release-page');
        const history = await within(page).findByTestId('release-revisions');
        await waitFor(() => expect(history).toHaveTextContent('#1'));

        const current = history.querySelector('[data-revision="2"]') as HTMLElement;
        expect(within(current).queryByRole('button', { name: 'Roll back' })).not.toBeInTheDocument();

        const older = history.querySelector('[data-revision="1"]') as HTMLElement;
        await userEvent.click(within(older).getByRole('button', { name: 'Roll back' }));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('Roll back to revision 1?');
        expect(dialog).toHaveTextContent('records this as a new revision');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('releases.rollback', {
                context: 'alpha',
                name: 'traefik',
                namespace: 'kube-system',
                revision: 1,
            }),
        );
        expect(toasts.success).toHaveBeenCalledWith('Rolled “traefik” back to revision 1', expect.anything());
    });

    it('leaves the release alone when either dialog is dismissed', async () => {
        renderRoutes(routeTree, '/addons/releases/kube-system/traefik/revisions');
        const page = await screen.findByTestId('release-page');
        const history = await within(page).findByTestId('release-revisions');
        await waitFor(() => expect(history).toHaveTextContent('#1'));
        const older = history.querySelector('[data-revision="1"]') as HTMLElement;
        await userEvent.click(within(older).getByRole('button', { name: 'Roll back' }));
        await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

        await userEvent.click(within(page).getByRole('button', { name: 'Uninstall' }));
        await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
        expect(invoke).not.toHaveBeenCalledWith('releases.rollback', expect.anything());
        expect(invoke).not.toHaveBeenCalledWith('releases.uninstall', expect.anything());
    });

    it('uninstalls a release, with the choice of keeping its history', async () => {
        renderRoutes(routeTree, '/addons/releases/kube-system/traefik');
        const page = await screen.findByTestId('release-page');
        await waitFor(() => expect(page).toHaveTextContent('revision: 2'));
        await userEvent.click(within(page).getByRole('button', { name: 'Uninstall' }));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('Uninstall traefik?');
        expect(dialog).toHaveTextContent('except any the chart marked to be kept');

        await userEvent.click(within(dialog).getByRole('switch', { name: /Keep the release history/ }));
        await userEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('releases.uninstall', {
                context: 'alpha',
                name: 'traefik',
                namespace: 'kube-system',
                keepHistory: true,
            }),
        );
        expect(toasts.success).toHaveBeenCalledWith('Release “traefik” uninstalled', {
            description: '4 object(s) removed, 1 kept by the chart.',
        });
    });

    it('shows the objects a revision rendered on its Manifest tab', async () => {
        renderRoutes(routeTree, '/addons/releases/kube-system/traefik');
        const page = await screen.findByTestId('release-page');
        await waitFor(() => expect(page).toHaveTextContent('revision: 2'));
        await userEvent.click(within(page).getByRole('tab', { name: /Manifest/ }));
        const panel = await within(page).findByTestId('release-manifest');
        // CodeMirror renders the document into its own content element.
        await waitFor(() => expect(panel.textContent).toContain('kind: Service'));
    });

    it('says a revision rendered no objects rather than showing an empty manifest', async () => {
        invoke.mockImplementation(async (channel: string) =>
            channel === 'releases.get' ? { ...release, manifest: undefined } : data[channel],
        );
        renderRoutes(routeTree, '/addons/releases/kube-system/traefik');
        const page = await screen.findByTestId('release-page');
        await waitFor(() => expect(page).toHaveTextContent('revision: 2'));
        await userEvent.click(within(page).getByRole('tab', { name: /Manifest/ }));
        const panel = await within(page).findByTestId('release-manifest');
        await waitFor(() => expect(panel.textContent).toContain('rendered no objects'));
    });

    it('says a release without user-supplied values runs on chart defaults', async () => {
        invoke.mockImplementation(async (channel: string) =>
            channel === 'releases.get' ? { ...release, values: undefined } : data[channel],
        );
        renderRoutes(routeTree, '/addons/releases/kube-system/traefik');
        const page = await screen.findByTestId('release-page');
        await waitFor(() => expect(page).toHaveTextContent('revision: 2'));
        await userEvent.click(within(page).getByRole('tab', { name: /Values/ }));
        expect(within(page).getByTestId('release-values')).toHaveTextContent('uses chart defaults');
    });

    it('shows a definition detail and reports a missing one without naming a namespace', async () => {
        const { router } = renderRoutes(routeTree, '/addons/crds/helmcharts.helm.cattle.io');
        const page = await screen.findByTestId('crd-page');
        await waitFor(() => expect(page).toHaveTextContent('group: helm.cattle.io'));
        expect(page).toHaveTextContent('kind: HelmChart');

        invoke.mockImplementation(async (channel: string, input: { kind?: string }) =>
            channel === 'resources.get' ? { kind: input.kind, item: null } : data[channel],
        );
        await router.navigate({ to: '/addons/crds/$name', params: { name: 'ghost' } });
        expect(await screen.findByTestId('not-found')).toHaveTextContent(
            'CustomResourceDefinition “ghost” was not found.',
        );
    });
});
