import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HELM_INSTALL_URL } from '../../../src/shared/helm-tool';
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

const { InstallChartDialog } = await import('@/components/chart/install-chart-dialog');

const bitnami = {
    name: 'bitnami',
    kind: 'classic',
    url: 'https://charts.example.com',
    hasCredentials: false,
    chartCount: 2,
    refreshedAt: '2026-09-22T10:00:00.000Z',
};
const ghcr = { ...bitnami, name: 'ghcr', kind: 'oci', url: 'oci://ghcr.io/example', chartCount: null };
const empty = { ...bitnami, name: 'empty', url: 'https://empty.example.com', chartCount: 0 };

const chartRow = (repository: string, name: string, latestVersion: string) => ({
    repository,
    name,
    latestVersion,
    appVersion: '1.0',
    description: `The ${name} chart`,
});

let data: Record<string, unknown>;

function show(props: { repository?: string; chart?: string } = {}) {
    const onOpenChange = vi.fn();
    const rendered = renderInRouter(<InstallChartDialog open onOpenChange={onOpenChange} {...props} />);
    return { ...rendered, onOpenChange };
}

describe('the install chart dialog', () => {
    beforeEach(() => {
        data = {
            'helm.status': { found: true, path: '/usr/local/bin/helm', version: '3.15.1' },
            'chartRepositories.list': [bitnami, ghcr, empty],
            'charts.list': [
                chartRow('bitnami', 'nginx', '18.2.0'),
                chartRow('bitnami', 'redis', '20.0.1'),
                chartRow('other', 'nginx', '1.0.0'),
            ],
        };
        invoke.mockReset();
        invoke.mockImplementation(async (channel: string) => data[channel]);
    });

    it('says Helm is required, links its install page, and finds one installed meanwhile', async () => {
        data['helm.status'] = { found: false };
        show();
        const dialog = await screen.findByRole('dialog');
        expect(await within(dialog).findByTestId('helm-required')).toHaveTextContent(
            'Helm is required to install a chart',
        );
        expect(within(dialog).getByRole('link', { name: /Install Helm/ })).toHaveAttribute('href', HELM_INSTALL_URL);
        expect(within(dialog).queryByRole('button', { name: 'Continue' })).toBeNull();

        data['helm.status'] = { found: true, path: '/usr/local/bin/helm', version: '3.15.1' };
        await userEvent.click(within(dialog).getByRole('button', { name: 'Check again' }));
        expect(await within(dialog).findByRole('button', { name: 'Continue' })).toBeInTheDocument();
    });

    it('picks a chart from a classic repository and opens its latest version', async () => {
        const { router, onOpenChange } = show({ repository: 'bitnami' });
        const dialog = await screen.findByRole('dialog');
        const list = await within(dialog).findByTestId('install-chart-picker');
        // Only this repository's charts, not a same-named chart elsewhere.
        expect(within(list).getAllByRole('option')).toHaveLength(2);
        const continueButton = within(dialog).getByRole('button', { name: 'Continue' });
        expect(continueButton).toBeDisabled();

        await userEvent.type(within(dialog).getByPlaceholderText('Search charts…'), 'red');
        await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1));
        await userEvent.click(within(list).getByRole('option', { name: /redis/ }));
        await userEvent.click(continueButton);
        await waitFor(() => expect(router.state.location.pathname).toBe('/helm/charts/install/bitnami/redis/20.0.1'));
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('says a classic repository whose index lists nothing has nothing to pick', async () => {
        show({ repository: 'empty' });
        const dialog = await screen.findByRole('dialog');
        expect(await within(dialog).findByTestId('install-chart-no-charts')).toHaveTextContent('empty lists no charts');
        expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeDisabled();
    });

    it('takes a chart name and a version for an OCI registry, which lists neither', async () => {
        const { router } = show({ repository: 'ghcr' });
        const dialog = await screen.findByRole('dialog');
        const chart = await within(dialog).findByLabelText('Chart name');
        const version = within(dialog).getByLabelText('Chart version');
        const continueButton = within(dialog).getByRole('button', { name: 'Continue' });

        await userEvent.type(chart, 'my/app');
        await userEvent.type(version, '1.0.0');
        expect(within(dialog).getByTestId('install-chart-problem')).toHaveTextContent('not a chart name');
        expect(continueButton).toBeDisabled();

        await userEvent.clear(chart);
        await userEvent.type(chart, 'podinfo');
        await userEvent.clear(version);
        await userEvent.type(version, '1.0 0');
        expect(within(dialog).getByTestId('install-chart-problem')).toHaveTextContent('not a chart version');

        await userEvent.clear(version);
        await userEvent.type(version, '6.7.0');
        expect(within(dialog).queryByTestId('install-chart-problem')).toBeNull();
        await userEvent.click(continueButton);
        await waitFor(() => expect(router.state.location.pathname).toBe('/helm/charts/install/ghcr/podinfo/6.7.0'));
    });

    it('asks which repository when none was given', async () => {
        const { router } = show();
        const dialog = await screen.findByRole('dialog');
        await userEvent.click(await within(dialog).findByRole('combobox', { name: 'Repository' }));
        await userEvent.click(await screen.findByRole('option', { name: /bitnami/ }));
        const list = await within(dialog).findByTestId('install-chart-picker');
        await userEvent.click(within(list).getByRole('option', { name: /nginx/ }));
        await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/helm/charts/install/bitnami/nginx/18.2.0'));
    });

    it('points at Settings › Charts when no repository is configured', async () => {
        data['chartRepositories.list'] = [];
        const { router } = show();
        const dialog = await screen.findByRole('dialog');
        const none = await within(dialog).findByTestId('install-chart-no-repositories');
        expect(none).toHaveTextContent('No chart repository is configured');
        await userEvent.click(within(none).getByRole('link', { name: 'Settings › Charts' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/settings/charts'));
    });

    it('opens a chart it was given without asking anything', async () => {
        const { router } = show({ repository: 'bitnami', chart: 'nginx' });
        const dialog = await screen.findByRole('dialog');
        expect(await within(dialog).findByText('nginx')).toBeInTheDocument();
        await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/helm/charts/install/bitnami/nginx/18.2.0'));
    });
});
