import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, screen, waitFor, within } from '@testing-library/react';
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
const { useRefreshIntervalMs } = await import('@/lib/settings');

const settings = {
    version: 1,
    session: { lastContext: 'alpha', lastNamespace: 'team-a', restoreOnLaunch: true },
    connection: { kubeconfigPath: null },
    data: { refreshIntervalSec: 12, readTimeoutSec: 45 },
    updates: { mode: null as string | null, checkIntervalHours: 4 },
};
const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date', checkedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
    'app.info': {
        name: 'Kubermeister',
        version: '0.2.1',
        electron: '44.3.0',
        chrome: '152.0.0.0',
        node: '24.21.0',
        platform: 'darwin',
        arch: 'arm64',
    },
    'settings.get': settings,
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'namespaces.list': [],
    'namespace.active': null,
    'cluster.active': null,
};

describe('settings screen', () => {
    beforeEach(() => {
        localStorage.clear();
        document.documentElement.classList.remove('light', 'dark');
        invoke.mockReset();
        invoke.mockImplementation(async (channel: string, input: unknown) => {
            if (channel === 'settings.set') {
                const patch = input as { session?: object; data?: object; updates?: object };
                return {
                    ...settings,
                    session: { ...settings.session, ...patch.session },
                    data: { ...settings.data, ...patch.data },
                    updates: { ...settings.updates, ...patch.updates },
                };
            }
            return data[channel];
        });
    });

    it('is reachable from the sidebar footer and shows the three sections', async () => {
        renderRoutes(routeTree, '/overview/summary');
        const sidebar = await screen.findByTestId('sidebar');
        await userEvent.click(within(sidebar).getByRole('link', { name: /Settings/ }));
        const page = await screen.findByTestId('settings-page');
        expect(page).toHaveTextContent('Preferences for this Kubermeister install.');
        for (const title of ['General', 'Appearance', 'Updates', 'Connection']) expect(page).toHaveTextContent(title);
        expect(within(sidebar).getByRole('link', { name: /Settings/ })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByTestId('breadcrumbs')).toHaveTextContent('Settings');
    });

    it('writes the session toggle and the refresh interval through the bridge', async () => {
        renderRoutes(routeTree, '/settings');
        const toggle = await screen.findByRole('switch', { name: 'Restore last session on launch' });
        await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
        await userEvent.click(toggle);
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('settings.set', { session: { restoreOnLaunch: false } }),
        );
        await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));

        await userEvent.click(screen.getByRole('combobox', { name: 'Refresh interval' }));
        await userEvent.click(await screen.findByRole('option', { name: '30 seconds' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings.set', { data: { refreshIntervalSec: 30 } }));
        expect(screen.getByRole('combobox', { name: 'Refresh interval' })).toHaveTextContent('30 seconds');
    });

    it('persists a larger log buffer through the bridge', async () => {
        renderRoutes(routeTree, '/settings');
        await screen.findByTestId('settings-page');
        await userEvent.click(screen.getByRole('combobox', { name: 'Buffered lines' }));
        await userEvent.click(await screen.findByRole('option', { name: '10k lines' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings.set', { data: { logBufferLines: 10000 } }));
        expect(screen.getByRole('combobox', { name: 'Buffered lines' })).toHaveTextContent('10k lines');
    });

    it('persists the read timeout through the bridge and offers the presets plus the current value', async () => {
        renderRoutes(routeTree, '/settings');
        await screen.findByTestId('settings-page');
        await userEvent.click(screen.getByRole('combobox', { name: 'Read timeout' }));
        const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
        // 45 is the persisted, non-preset value; it must still be selectable.
        expect(options).toEqual(['15 seconds', '30 seconds', '45 seconds', '60 seconds', '120 seconds', '300 seconds']);
        await userEvent.click(screen.getByRole('option', { name: '120 seconds' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings.set', { data: { readTimeoutSec: 120 } }));
        expect(screen.getByRole('combobox', { name: 'Read timeout' })).toHaveTextContent('120 seconds');
    });

    it('offers the preset intervals plus the current non-preset value', async () => {
        renderRoutes(routeTree, '/settings');
        await screen.findByTestId('settings-page');
        await userEvent.click(screen.getByRole('combobox', { name: 'Refresh interval' }));
        const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
        expect(options).toEqual(['5 seconds', '10 seconds', '12 seconds', '15 seconds', '30 seconds', '60 seconds']);
    });

    it('shows the default until a mode is chosen, then persists the choice', async () => {
        renderRoutes(routeTree, '/settings');
        const select = await screen.findByRole('combobox', { name: 'When a new version is found' });
        // Nobody has chosen: the screen names the mode the app would use, not an empty control.
        await waitFor(() => expect(select).toHaveTextContent('Download in the background'));
        await userEvent.click(select);
        const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
        expect(options).toEqual([
            'Notify me and let me choose',
            'Download in the background',
            'Never check automatically',
        ]);
        await userEvent.click(screen.getByRole('option', { name: 'Notify me and let me choose' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings.set', { updates: { mode: 'check' } }));
        expect(select).toHaveTextContent('Notify me and let me choose');
    });

    it('persists the update check interval through the bridge, folding in a non-preset value', async () => {
        settings.updates.checkIntervalHours = 6;
        renderRoutes(routeTree, '/settings');
        const select = await screen.findByRole('combobox', { name: 'Check for new versions' });
        await waitFor(() => expect(select).toHaveTextContent('Every 6 hours'));
        await userEvent.click(select);
        const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
        expect(options).toEqual(['Every hour', 'Every 4 hours', 'Every 6 hours', 'Every 12 hours', 'Once a day']);
        await userEvent.click(screen.getByRole('option', { name: 'Once a day' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('settings.set', { updates: { checkIntervalHours: 24 } }),
        );
        expect(select).toHaveTextContent('Once a day');
    });

    it('links a bug report prefilled with the version and the operating system', async () => {
        renderRoutes(routeTree, '/settings');
        const about = await screen.findByTestId('about-card');
        const link = await within(about).findByRole('link', { name: /Report a bug/ });
        const url = new URL(link.getAttribute('href')!);
        expect(url.origin + url.pathname).toBe('https://github.com/kubermeister/kubermeister/issues/new');
        expect(url.searchParams.get('template')).toBe('bug_report.yml');
        // Both come off this very card, so nobody retypes them into the form.
        expect(url.searchParams.get('version')).toBe('0.2.1');
        expect(url.searchParams.get('os')).toBe('macOS (Apple silicon)');
    });

    it('shows this install and the last check, and runs a check on demand', async () => {
        invoke.mockImplementation(async (channel: string) =>
            channel === 'update.check'
                ? { status: 'available', version: '0.2.2', releaseDate: '2026-09-16T06:48:44.854Z' }
                : data[channel],
        );
        renderRoutes(routeTree, '/settings');
        const about = await screen.findByTestId('about-card');
        await waitFor(() => expect(about).toHaveTextContent('Kubermeister'));
        expect(about).toHaveTextContent('0.2.1');
        expect(about).toHaveTextContent('Electron 44.3.0 · Chrome 152.0.0.0 · Node 24.21.0');
        const status = screen.getByTestId('update-status');
        await waitFor(() => expect(status).toHaveTextContent("You're on the latest version."));
        expect(status).toHaveTextContent('Checked 5 min ago.');

        await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('update.check', {}));
        await waitFor(() => expect(status).toHaveTextContent('Version 0.2.2 is available.'));
        // The changelog stays on the release page, which the card links to rather than reciting.
        expect(status).toHaveTextContent(/Released .*2026\./);
        expect(screen.getByRole('link', { name: /What's new/ })).toHaveAttribute(
            'href',
            'https://github.com/kubermeister/kubermeister/releases/tag/v0.2.2',
        );
        await userEvent.click(screen.getByRole('button', { name: 'Download update' }));
        expect(invoke).toHaveBeenCalledWith('update.download', {});
    });

    it('disables the check where in-app updates cannot run and offers the restart once downloaded', async () => {
        invoke.mockImplementation(async (channel: string) =>
            channel === 'update.state' ? { status: 'unsupported', message: 'Development build' } : data[channel],
        );
        renderRoutes(routeTree, '/settings');
        const status = await screen.findByTestId('update-status');
        await waitFor(() => expect(status).toHaveTextContent('In-app updates are unavailable here.'));
        expect(status).toHaveTextContent('Development build');
        expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();

        invoke.mockImplementation(async (channel: string) =>
            channel === 'update.state' ? { status: 'downloaded', version: '0.3.0' } : data[channel],
        );
        renderRoutes(routeTree, '/settings');
        const restart = await screen.findByRole('button', { name: 'Restart now' });
        await userEvent.click(restart);
        expect(invoke).toHaveBeenCalledWith('update.install', {});
    });

    it('switches the theme from the cards and persists it', async () => {
        renderRoutes(routeTree, '/settings');
        const group = await screen.findByRole('radiogroup', { name: 'Theme' });
        expect(within(group).getByRole('radio', { name: /Dark/ })).toHaveAttribute('aria-checked', 'true');
        await userEvent.click(within(group).getByRole('radio', { name: /Light/ }));
        expect(document.documentElement).toHaveClass('light');
        expect(localStorage.getItem('km-theme')).toBe('light');
        expect(within(group).getByRole('radio', { name: /Light/ })).toHaveAttribute('aria-checked', 'true');
    });

    it('picks a kubeconfig through the native dialog and resets to the default', async () => {
        let path: string | null = null;
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'kubeconfig.pick') {
                path = '/tmp/other';
                return { path };
            }
            if (channel === 'kubeconfig.useDefault') {
                path = null;
                return { ...settings, connection: { kubeconfigPath: null } };
            }
            if (channel === 'settings.get') return { ...settings, connection: { kubeconfigPath: path } };
            return data[channel];
        });
        renderRoutes(routeTree, '/settings');
        const shown = await screen.findByTestId('kubeconfig-path');
        expect(shown).toHaveTextContent('$KUBECONFIG or ~/.kube/config (default)');
        expect(screen.getByRole('button', { name: 'Use default' })).toBeDisabled();
        await userEvent.click(screen.getByRole('button', { name: 'Browse…' }));
        await waitFor(() => expect(shown).toHaveTextContent('/tmp/other'));
        expect(invoke).toHaveBeenCalledWith('kubeconfig.pick', {});
        await userEvent.click(screen.getByRole('button', { name: 'Use default' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('kubeconfig.useDefault', {}));
        await waitFor(() => expect(shown).toHaveTextContent('(default)'));
    });

    it('ignores a cancelled dialog', async () => {
        invoke.mockImplementation(async (channel: string) =>
            channel === 'kubeconfig.pick' ? { path: null } : data[channel],
        );
        renderRoutes(routeTree, '/settings');
        await userEvent.click(await screen.findByRole('button', { name: 'Browse…' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('kubeconfig.pick', {}));
        expect(invoke.mock.calls.filter(([c]) => c === 'settings.get')).toHaveLength(1);
    });
});

describe('useRefreshIntervalMs', () => {
    it('falls back while settings load and then follows the persisted interval', async () => {
        invoke.mockReset();
        let resolve!: (value: unknown) => void;
        invoke.mockImplementation(() => new Promise((r) => (resolve = r)));
        const client = new QueryClient();
        const { result } = renderHook(() => useRefreshIntervalMs(5_000), {
            wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
        });
        expect(result.current).toBe(5_000);
        resolve({ ...settings, data: { refreshIntervalSec: 30 } });
        await waitFor(() => expect(result.current).toBe(30_000));
    });
});
