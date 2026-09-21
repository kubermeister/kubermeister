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

const bitnami = {
    name: 'bitnami',
    kind: 'classic',
    url: 'https://charts.example.com',
    hasCredentials: false,
    chartCount: 132,
    refreshedAt: '2026-09-22T10:00:00.000Z',
};
const ghcr = {
    name: 'ghcr',
    kind: 'oci',
    url: 'oci://ghcr.io/example',
    hasCredentials: true,
    chartCount: null,
    refreshedAt: null,
};

let repositories: unknown[] = [];

const settings = {
    version: 1,
    session: { lastContext: 'alpha', lastNamespace: null, restoreOnLaunch: true },
    connection: { kubeconfigPath: null },
    data: { refreshIntervalSec: 12, readTimeoutSec: 60, logBufferLines: 2000, terminalFontSize: 12, forwards: [] },
    updates: { mode: 'check', checkIntervalHours: 4 },
    charts: { repositories: [] },
    window: { bounds: null },
};

const data: Record<string, unknown> = {
    'settings.get': settings,
    'app.info': {
        name: 'Kubermeister',
        version: '0.4.9',
        electron: '44.4.1',
        chrome: '152.0.0.0',
        node: '24.21.0',
        platform: 'darwin',
        arch: 'arm64',
    },
    'update.state': { status: 'up-to-date' },
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'namespaces.list': [],
    'namespace.active': null,
    'cluster.active': null,
};

/** Fill the add form and submit it. */
async function addRepository(fields: { name: string; url: string; oci?: boolean; user?: string; password?: string }) {
    await userEvent.click(await screen.findByTestId('add-chart-repository'));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByLabelText('Repository name'), fields.name);
    if (fields.oci) await userEvent.click(within(dialog).getByRole('radio', { name: /OCI registry/ }));
    await userEvent.type(within(dialog).getByLabelText('Repository URL'), fields.url);
    if (fields.user) await userEvent.type(within(dialog).getByLabelText('Username'), fields.user);
    if (fields.password) await userEvent.type(within(dialog).getByLabelText('Password'), fields.password);
    return dialog;
}

describe('chart repositories in Settings', () => {
    beforeEach(() => {
        localStorage.clear();
        repositories = [];
        invoke.mockReset();
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'chartRepositories.list') return repositories;
            if (channel === 'settings.set') return settings;
            return data[channel];
        });
    });

    it('lists the configured sources with what the cache holds for each', async () => {
        repositories = [bitnami, ghcr];
        renderRoutes(routeTree, '/settings');
        const classic = await screen.findByTestId('repository-bitnami');
        expect(classic).toHaveTextContent('bitnami');
        expect(classic).toHaveTextContent('https://charts.example.com');
        expect(classic).toHaveTextContent('132');
        const oci = screen.getByTestId('repository-ghcr');
        expect(oci).toHaveTextContent('OCI');
        // A registry publishes no index, so it has no chart count and no refresh time to show.
        expect(oci).toHaveTextContent('Never');
        expect(within(oci).getByTestId('repository-credentials-ghcr')).toBeInTheDocument();
        expect(within(classic).queryByTestId('repository-credentials-bitnami')).not.toBeInTheDocument();
    });

    it('says the list is empty rather than showing an empty table', async () => {
        renderRoutes(routeTree, '/settings');
        const table = await screen.findByTestId('chart-repositories');
        expect(table).toHaveTextContent(/No chart repositories yet/i);
        expect(within(table).queryByRole('row')).not.toBeInTheDocument();
    });

    it('adds a classic repository through the bridge', async () => {
        renderRoutes(routeTree, '/settings');
        const dialog = await addRepository({ name: 'bitnami', url: 'https://charts.example.com' });
        await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('chartRepositories.add', {
                name: 'bitnami',
                kind: 'classic',
                url: 'https://charts.example.com',
            }),
        );
    });

    it('adds an OCI registry with the credential the user typed', async () => {
        renderRoutes(routeTree, '/settings');
        const dialog = await addRepository({
            name: 'ghcr',
            url: 'oci://ghcr.io/example',
            oci: true,
            user: 'ara',
            password: 'hunter2',
        });
        await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('chartRepositories.add', {
                name: 'ghcr',
                kind: 'oci',
                url: 'oci://ghcr.io/example',
                username: 'ara',
                password: 'hunter2',
            }),
        );
    });

    it('will not submit a URL the chosen kind is never published under', async () => {
        renderRoutes(routeTree, '/settings');
        const dialog = await addRepository({ name: 'ghcr', url: 'https://ghcr.io/example', oci: true });
        expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
        expect(dialog).toHaveTextContent(/oci:\/\//);
    });

    it('will not send a password to a plaintext http repository', async () => {
        renderRoutes(routeTree, '/settings');
        const dialog = await addRepository({
            name: 'local',
            url: 'http://charts.example.com',
            user: 'ara',
            password: 'hunter2',
        });
        expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
        expect(dialog).toHaveTextContent(/https/i);
    });

    it('refreshes one repository without touching the others', async () => {
        repositories = [bitnami, ghcr];
        renderRoutes(routeTree, '/settings');
        const row = await screen.findByTestId('repository-bitnami');
        await userEvent.click(within(row).getByRole('button', { name: 'Refresh bitnami' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('chartRepositories.refresh', { name: 'bitnami' }));
    });

    it('asks before removing a repository, since its credential goes with it', async () => {
        repositories = [bitnami];
        renderRoutes(routeTree, '/settings');
        const row = await screen.findByTestId('repository-bitnami');
        await userEvent.click(within(row).getByRole('button', { name: 'Remove bitnami' }));
        const confirm = await screen.findByRole('alertdialog');
        expect(confirm).toHaveTextContent(/bitnami/);
        expect(invoke).not.toHaveBeenCalledWith('chartRepositories.remove', expect.anything());
        await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('chartRepositories.remove', { name: 'bitnami' }));
    });
});
