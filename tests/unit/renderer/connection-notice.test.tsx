import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartupReport } from '../../../src/shared/ipc';
import { renderWithQuery } from './helpers';
import { settingsFixture } from './settings-fixture';

const invoke = vi.fn();
vi.mock('@/lib/ipc', async () => ({ ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')), invoke }));

const { ConnectionNotice } = await import('@/components/layout/connection-notice');

const passing: StartupReport = {
    ok: true,
    checks: [
        { id: 'kubeconfig', label: 'Kubeconfig file', status: 'ok', detail: 'Kubeconfig loaded' },
        { id: 'cluster', label: 'Cluster connection', status: 'ok' },
    ],
};
const failing: StartupReport = {
    ok: false,
    checks: [
        {
            id: 'kubeconfig',
            label: 'Kubeconfig file',
            status: 'error',
            detail: 'No file exists at /k.',
            hint: 'Fix or clear the kubeconfig path in Settings.',
        },
        { id: 'cluster', label: 'Cluster connection', status: 'warning', detail: 'Skipped' },
    ],
};

const brokenContext: StartupReport = {
    ok: false,
    checks: [
        { id: 'kubeconfig', label: 'Kubeconfig file', status: 'ok', detail: 'Kubeconfig loaded' },
        {
            id: 'context',
            label: 'Current context',
            status: 'error',
            detail: 'Context "alpha" names cluster "nowhere", which the kubeconfig does not define or which has no server.',
            hint: 'Switch to another context in the top bar, or fix the entry in the kubeconfig.',
        },
        { id: 'cluster', label: 'Cluster connection', status: 'warning', detail: 'Skipped' },
    ],
};

const unreadableBundle: StartupReport = {
    ok: false,
    checks: [
        { id: 'kubeconfig', label: 'Kubeconfig file', status: 'ok', detail: 'Kubeconfig loaded' },
        {
            id: 'network',
            label: 'Proxy and certificates',
            status: 'error',
            detail: 'The CA bundle at /etc/corp/ca.pem could not be read.',
            hint: 'Fix or clear the CA bundle in Settings.',
        },
        { id: 'cluster', label: 'Cluster connection', status: 'warning', detail: 'Skipped' },
    ],
};

let report: StartupReport;
let kubeconfigPath: string | null;

describe('ConnectionNotice', () => {
    beforeEach(() => {
        report = failing;
        kubeconfigPath = '/k';
        invoke.mockReset();
        invoke.mockImplementation(async (channel: string) => {
            switch (channel) {
                case 'startupChecks':
                    return report;
                case 'settings.get':
                    return settingsFixture({ connection: { kubeconfigPath } });
                case 'kubeconfig.pick':
                    report = passing;
                    return { path: '/picked' };
                case 'kubeconfig.useDefault':
                    report = passing;
                    return settingsFixture();
                default:
                    throw new Error(`unexpected ${channel}`);
            }
        });
    });

    it('renders nothing while the kubeconfig loads or the report is still on its way', async () => {
        report = passing;
        renderWithQuery(<ConnectionNotice />);
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('startupChecks', {}));
        expect(screen.queryByTestId('connection-notice')).not.toBeInTheDocument();
    });

    it('names the failure and opens to the detail, the hint and the fixes', async () => {
        renderWithQuery(<ConnectionNotice />);
        const notice = await screen.findByTestId('connection-notice');
        expect(notice).toHaveTextContent('Kubeconfig not loaded');
        await userEvent.click(notice);
        expect(await screen.findByText('No file exists at /k.')).toBeInTheDocument();
        expect(screen.getByText('Fix or clear the kubeconfig path in Settings.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Choose kubeconfig…' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Use default kubeconfig' })).toBeInTheDocument();
    });

    it('names a context the kubeconfig cannot back and says to switch', async () => {
        report = brokenContext;
        renderWithQuery(<ConnectionNotice />);
        const notice = await screen.findByTestId('connection-notice');
        expect(notice).toHaveTextContent('Context unusable');
        await userEvent.click(notice);
        expect(await screen.findByText(/names cluster "nowhere"/)).toBeInTheDocument();
        expect(screen.getByText(/Switch to another context/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('names a CA bundle it cannot read, and offers only the fixes that would help', async () => {
        report = unreadableBundle;
        renderWithQuery(<ConnectionNotice />);
        const notice = await screen.findByTestId('connection-notice');
        expect(notice).toHaveTextContent('CA bundle unreadable');
        await userEvent.click(notice);
        expect(await screen.findByText(/\/etc\/corp\/ca\.pem could not be read/)).toBeInTheDocument();
        expect(screen.getByText('Fix or clear the CA bundle in Settings.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        // Another kubeconfig would not make this file readable.
        expect(screen.queryByRole('button', { name: 'Choose kubeconfig…' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Use default kubeconfig' })).not.toBeInTheDocument();
    });

    it('offers no reset to the default when no path override is set', async () => {
        kubeconfigPath = null;
        renderWithQuery(<ConnectionNotice />);
        await userEvent.click(await screen.findByTestId('connection-notice'));
        await screen.findByRole('button', { name: 'Try again' });
        expect(screen.queryByRole('button', { name: 'Use default kubeconfig' })).not.toBeInTheDocument();
    });

    it('picks a kubeconfig, reruns the checks and disappears once they pass', async () => {
        renderWithQuery(<ConnectionNotice />);
        await userEvent.click(await screen.findByTestId('connection-notice'));
        await userEvent.click(await screen.findByRole('button', { name: 'Choose kubeconfig…' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('kubeconfig.pick', {}));
        await waitFor(() => expect(screen.queryByTestId('connection-notice')).not.toBeInTheDocument());
        expect(invoke.mock.calls.filter(([channel]) => channel === 'startupChecks').length).toBeGreaterThan(1);
    });

    it('resets to the default kubeconfig and reruns the checks', async () => {
        renderWithQuery(<ConnectionNotice />);
        await userEvent.click(await screen.findByTestId('connection-notice'));
        await userEvent.click(await screen.findByRole('button', { name: 'Use default kubeconfig' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('kubeconfig.useDefault', {}));
        await waitFor(() => expect(screen.queryByTestId('connection-notice')).not.toBeInTheDocument());
    });

    it('stays, still failing, when a retry finds the same problem', async () => {
        renderWithQuery(<ConnectionNotice />);
        await userEvent.click(await screen.findByTestId('connection-notice'));
        await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
        await waitFor(() =>
            expect(invoke.mock.calls.filter(([channel]) => channel === 'startupChecks').length).toBe(2),
        );
        expect(screen.getByTestId('connection-notice')).toBeInTheDocument();
        expect(invoke).not.toHaveBeenCalledWith('kubeconfig.pick', {});
    });
});
