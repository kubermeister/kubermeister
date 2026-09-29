import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderInRouter } from './helpers';

const invoke = vi.fn();
const subscribe = vi.fn(() => () => {});
const stream = vi.fn(() => ({ stop: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    subscribe,
    stream,
}));

// The card alone, not the Settings route it sits on: mounting the whole app to reach one card cost
// eight route renders in this file, and their budget was how fast the runner was. That the Charts
// section carries this card is asserted once, on the screen itself, in `settings.test.tsx`.
const { ChartRepositoriesCard } = await import('@/components/settings/chart-repositories-card');
const { IpcError } = await import('@/lib/ipc');

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

describe('the chart repositories card', () => {
    beforeEach(() => {
        localStorage.clear();
        repositories = [];
        invoke.mockReset();
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'chartRepositories.list') return repositories;
            if (channel === 'helm.status') return { found: true, path: '/usr/local/bin/helm', version: '3.15.1' };
            if (channel === 'charts.list') return [];
            return undefined;
        });
    });

    it('lists the configured sources with what the cache holds for each', async () => {
        repositories = [bitnami, ghcr];
        renderInRouter(<ChartRepositoriesCard />);
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

    it('installs a chart from one repository, the dialog opening on that repository', async () => {
        repositories = [bitnami, ghcr];
        const { router } = renderInRouter(<ChartRepositoriesCard />);
        const oci = await screen.findByTestId('repository-ghcr');
        await userEvent.click(within(oci).getByRole('button', { name: 'Install a chart from ghcr' }));
        const dialog = await screen.findByRole('dialog');
        // An OCI registry lists nothing, so the chart is named rather than picked.
        await userEvent.type(await within(dialog).findByLabelText('Chart name'), 'podinfo');
        expect(dialog).toHaveTextContent('From ghcr');
        await userEvent.type(within(dialog).getByLabelText('Chart version'), '6.7.0');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/helm/charts/install/ghcr/podinfo/6.7.0'));
    });

    it('says the list is empty rather than showing an empty table', async () => {
        renderInRouter(<ChartRepositoriesCard />);
        const table = await screen.findByTestId('chart-repositories');
        expect(table).toHaveTextContent(/No chart repositories yet/i);
        expect(within(table).queryByRole('row')).not.toBeInTheDocument();
    });

    it('adds a classic repository through the bridge', async () => {
        renderInRouter(<ChartRepositoriesCard />);
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
        renderInRouter(<ChartRepositoriesCard />);
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

    it('keeps the dialog and what was typed when main refuses the source', async () => {
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'chartRepositories.list') return repositories;
            if (channel === 'chartRepositories.add')
                throw new IpcError({ kind: 'invalid', detail: 'No chart index there.', op: 'chartRepositories.add' });
            return undefined;
        });
        renderInRouter(<ChartRepositoriesCard />);
        const dialog = await addRepository({ name: 'bitnami', url: 'https://charts.example.com/login' });
        await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('chartRepositories.add', expect.anything()));
        await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Add' })).toBeEnabled());
        expect(screen.getByRole('alertdialog')).toBe(dialog);
        expect(within(dialog).getByLabelText('Repository URL')).toHaveValue('https://charts.example.com/login');
    });

    it('closes the dialog once the source is added', async () => {
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'chartRepositories.list') return repositories;
            if (channel === 'chartRepositories.add') return bitnami;
            return undefined;
        });
        renderInRouter(<ChartRepositoriesCard />);
        const dialog = await addRepository({ name: 'bitnami', url: 'https://charts.example.com' });
        await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    });

    it('will not submit a URL the chosen kind is never published under', async () => {
        renderInRouter(<ChartRepositoriesCard />);
        const dialog = await addRepository({ name: 'ghcr', url: 'https://ghcr.io/example', oci: true });
        expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
        expect(dialog).toHaveTextContent(/oci:\/\//);
    });

    it('will not send a password to a plaintext http repository', async () => {
        renderInRouter(<ChartRepositoriesCard />);
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
        renderInRouter(<ChartRepositoriesCard />);
        const row = await screen.findByTestId('repository-bitnami');
        await userEvent.click(within(row).getByRole('button', { name: 'Refresh bitnami' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('chartRepositories.refresh', { name: 'bitnami' }));
    });

    it('asks before removing a repository, since its credential goes with it', async () => {
        repositories = [bitnami];
        renderInRouter(<ChartRepositoriesCard />);
        const row = await screen.findByTestId('repository-bitnami');
        await userEvent.click(within(row).getByRole('button', { name: 'Remove bitnami' }));
        const confirm = await screen.findByRole('alertdialog');
        expect(confirm).toHaveTextContent(/bitnami/);
        expect(invoke).not.toHaveBeenCalledWith('chartRepositories.remove', expect.anything());
        await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('chartRepositories.remove', { name: 'bitnami' }));
    });
});
