import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartupReport } from '../../../src/shared/ipc';
import { renderWithQuery } from './helpers';

const invoke = vi.fn();
vi.mock('@/lib/ipc', async () => ({ ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')), invoke }));

const { StartupGate } = await import('@/components/startup-gate');

const passing: StartupReport = {
    ok: true,
    checks: [
        { id: 'kubeconfig', label: 'Kubeconfig file', status: 'ok' },
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

describe('StartupGate', () => {
    beforeEach(() => {
        invoke.mockReset();
    });

    it('shows the preloader, then the app once the checks pass', async () => {
        invoke.mockResolvedValueOnce(passing);
        renderWithQuery(
            <StartupGate>
                <p>the app</p>
            </StartupGate>,
        );
        expect(screen.getByRole('status')).toBeInTheDocument();
        expect(await screen.findByText('the app')).toBeInTheDocument();
        expect(invoke).toHaveBeenCalledWith('startupChecks', {});
    });

    it('opens the app anyway when the kubeconfig check fails; the top bar carries the failure', async () => {
        invoke.mockResolvedValueOnce(failing);
        renderWithQuery(
            <StartupGate>
                <p>the app</p>
            </StartupGate>,
        );
        expect(await screen.findByText('the app')).toBeInTheDocument();
        expect(screen.queryByTestId('startup-error')).not.toBeInTheDocument();
    });

    it('blocks on a bridge failure with a retry, since nothing behind it could answer either', async () => {
        invoke.mockRejectedValueOnce(new Error('blocked IPC channel: startupChecks')).mockResolvedValueOnce(passing);
        renderWithQuery(
            <StartupGate>
                <p>the app</p>
            </StartupGate>,
        );
        const card = await screen.findByTestId('startup-error');
        expect(card).toHaveTextContent('blocked IPC channel: startupChecks');
        expect(screen.queryByText('the app')).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('the app')).toBeInTheDocument();
    });
});
