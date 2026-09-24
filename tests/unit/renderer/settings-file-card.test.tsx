import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsFileStatus } from '../../../src/shared/settings';
import { renderWithQuery } from './helpers';

const invoke = vi.fn();
vi.mock('@/lib/ipc', async () => ({ ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')), invoke }));

const { SettingsFileCard } = await import('@/components/settings/settings-file-card');

const PATH = '/home/me/.config/kubermeister/settings.json';
let status: SettingsFileStatus;

describe('SettingsFileCard', () => {
    beforeEach(() => {
        status = { path: PATH, exists: true, readOnly: null, blocked: false, problems: [] };
        invoke.mockReset();
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'settingsFile.status') return status;
            if (channel === 'settingsFile.reveal') return {};
            throw new Error(`unexpected ${channel}`);
        });
    });

    it('names the file and shows it in the file manager', async () => {
        renderWithQuery(<SettingsFileCard />);
        expect(await screen.findByText(PATH)).toBeInTheDocument();
        expect(screen.queryByTestId('settings-file-problems')).not.toBeInTheDocument();
        expect(screen.queryByTestId('settings-file-read-only')).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Show file' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('settingsFile.reveal', {}));
    });

    it('says the defaults are in use while no file exists', async () => {
        status = { ...status, exists: false };
        renderWithQuery(<SettingsFileCard />);
        expect(await screen.findByText(/No file yet/)).toBeInTheDocument();
    });

    it('lists every value the app refused, by its path', async () => {
        status = {
            ...status,
            problems: [
                { path: 'data.readTimeoutSec', message: 'Too small: expected number to be >=5' },
                { path: 'extra', message: 'Unknown section, ignored.' },
            ],
        };
        renderWithQuery(<SettingsFileCard />);
        const problems = await screen.findByTestId('settings-file-problems');
        expect(problems).toHaveTextContent('data.readTimeoutSec Too small: expected number to be >=5');
        expect(problems).toHaveTextContent('extra Unknown section, ignored.');
    });

    it('says why the file is not being written', async () => {
        status = { ...status, blocked: true, readOnly: 'It is not valid JSON: Unexpected token.' };
        renderWithQuery(<SettingsFileCard />);
        expect(await screen.findByTestId('settings-file-read-only')).toHaveTextContent(
            'It is not valid JSON: Unexpected token.',
        );
    });
});
