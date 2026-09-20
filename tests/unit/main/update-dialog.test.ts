import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../../src/shared/ipc';

const showMessageBox = vi.fn<(...args: unknown[]) => Promise<{ response: number }>>();
const focused = { id: 'focused' };
const electron = {
    app: { getVersion: () => '0.4.0' },
    BrowserWindow: {
        getFocusedWindow: vi.fn<() => unknown>(() => focused),
        getAllWindows: vi.fn<() => unknown[]>(() => [focused]),
    },
    dialog: { showMessageBox },
};
vi.mock('electron', () => electron);

const openExternally = vi.fn<(url: string) => void>();
vi.mock('../../../src/main/window.js', () => ({ openExternally }));

let state: UpdateState = { status: 'idle' };
const listeners = new Set<(next: UpdateState) => void>();
function transition(next: UpdateState): void {
    state = next;
    for (const listener of listeners) listener(next);
}
const updater = {
    getUpdateState: vi.fn(() => state),
    onUpdateState: vi.fn((listener: (next: UpdateState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }),
    checkForUpdates: vi.fn<() => Promise<UpdateState>>(),
    downloadUpdate: vi.fn(() => {
        transition({ status: 'downloading', version: state.version, percent: 0 });
        return true;
    }),
    installUpdate: vi.fn(() => true),
};
vi.mock('../../../src/main/updater.js', () => updater);

const { promptFor, downloadFailedPrompt, whenDownloadSettles, runInteractiveCheck } =
    await import('../../../src/main/update-dialog.js');

const found: UpdateState = {
    status: 'available',
    version: '0.5.0',
    releaseDate: '2026-09-16T06:48:44.854Z',
    checkedAt: '2026-09-16T07:00:00.000Z',
};

/** Answer the next message box with its button at `index`. */
const answer = (index: number) => showMessageBox.mockResolvedValueOnce({ response: index });
const boxes = () => showMessageBox.mock.calls.map((call) => call[call.length - 1] as { message: string });
const messages = () => boxes().map((box) => box.message);

describe('promptFor', () => {
    it('offers to download a found version, naming both versions and where to read the changes', () => {
        const prompt = promptFor(found, '0.4.0');
        expect(prompt).toMatchObject({
            type: 'info',
            buttons: ['Download', 'Release Notes', 'Later'],
            actions: ['download', 'notes', 'dismiss'],
        });
        expect(prompt.message).toBe('Kubermeister 0.5.0 is available.');
        expect(prompt.detail).toContain('You have 0.4.0.');
        expect(prompt.detail).toContain('Released ');
    });

    it('drops an unreadable release date rather than printing it', () => {
        expect(promptFor({ ...found, releaseDate: 'yesterday' }, '0.4.0').detail).not.toContain('Released');
    });

    it('leaves out the release notes button for a found version that lost its version', () => {
        expect(promptFor({ status: 'available' }, '0.4.0')).toMatchObject({
            buttons: ['Download', 'Later'],
            actions: ['download', 'dismiss'],
        });
    });

    it('offers a restart for a downloaded version and reports a download in flight', () => {
        expect(promptFor({ status: 'downloaded', version: '0.5.0' }, '0.4.0')).toMatchObject({
            message: 'Kubermeister 0.5.0 is ready to install.',
            buttons: ['Restart Now', 'Later'],
            actions: ['install', 'dismiss'],
        });
        expect(promptFor({ status: 'downloading', version: '0.5.0', percent: 12 }, '0.4.0')).toMatchObject({
            message: 'Kubermeister 0.5.0 is downloading.',
            buttons: ['OK'],
            actions: ['dismiss'],
        });
    });

    it('states the current version when it is the latest', () => {
        expect(promptFor({ status: 'up-to-date', checkedAt: 'now' }, '0.4.0')).toMatchObject({
            type: 'info',
            message: 'Kubermeister 0.4.0 is up to date.',
            actions: ['dismiss'],
        });
    });

    it('explains an unsupported build and a failed check with the reason', () => {
        expect(promptFor({ status: 'unsupported', message: 'Development build' }, '0.4.0')).toMatchObject({
            type: 'info',
            detail: 'Development build',
            actions: ['dismiss'],
        });
        expect(promptFor({ status: 'error', message: 'offline' }, '0.4.0')).toMatchObject({
            type: 'error',
            message: 'Kubermeister could not check for updates.',
            detail: 'offline',
        });
    });

    it('treats an unsettled state as a check that did not finish', () => {
        for (const status of ['idle', 'checking'] as const) {
            expect(promptFor({ status }, '0.4.0')).toMatchObject({
                type: 'error',
                detail: 'The check did not finish.',
            });
        }
    });

    it('names a state that lost its version without a dangling space', () => {
        expect(promptFor({ status: 'downloaded' }, '0.4.0').message).toBe('Kubermeister is ready to install.');
        expect(downloadFailedPrompt({ status: 'error', message: 'disk full' })).toMatchObject({
            type: 'error',
            message: 'The update could not be downloaded.',
            detail: 'disk full',
        });
    });
});

describe('whenDownloadSettles', () => {
    beforeEach(() => {
        listeners.clear();
        state = { status: 'idle' };
    });

    it('answers at once when the download is already over', async () => {
        state = { status: 'downloaded', version: '0.5.0' };
        await expect(whenDownloadSettles()).resolves.toEqual(state);
        expect(updater.onUpdateState).not.toHaveBeenCalled();
    });

    it('waits through progress for the download to land or fail, then stops listening', async () => {
        state = { status: 'downloading', version: '0.5.0', percent: 0 };
        const settled = whenDownloadSettles();
        transition({ status: 'downloading', version: '0.5.0', percent: 50 });
        expect(listeners.size).toBe(1);
        transition({ status: 'error', message: 'disk full' });
        await expect(settled).resolves.toEqual({ status: 'error', message: 'disk full' });
        expect(listeners.size).toBe(0);
    });
});

describe('runInteractiveCheck', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listeners.clear();
        state = { status: 'idle' };
        electron.BrowserWindow.getFocusedWindow.mockReturnValue(focused);
        electron.BrowserWindow.getAllWindows.mockReturnValue([focused]);
        updater.checkForUpdates.mockImplementation(async () => {
            transition(found);
            return found;
        });
    });

    it('checks, offers the download over the app window and asks to restart once it lands', async () => {
        answer(0); // Download
        answer(0); // Restart Now
        const run = runInteractiveCheck();
        await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledOnce());
        transition({ status: 'downloaded', version: '0.5.0' });
        await run;
        expect(updater.checkForUpdates).toHaveBeenCalledOnce();
        expect(messages()).toEqual(['Kubermeister 0.5.0 is available.', 'Kubermeister 0.5.0 is ready to install.']);
        expect(showMessageBox.mock.calls[0]?.[0]).toBe(focused);
        expect(showMessageBox.mock.calls[0]?.[1]).toMatchObject({
            buttons: ['Download', 'Release Notes', 'Later'],
            defaultId: 0,
            cancelId: 2,
            noLink: true,
        });
        expect(updater.installUpdate).toHaveBeenCalledOnce();
    });

    it('opens the release page and asks again when the user reads the notes first', async () => {
        answer(1); // Release Notes
        answer(0); // Download
        answer(0); // Restart Now
        const run = runInteractiveCheck();
        await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledOnce());
        transition({ status: 'downloaded', version: '0.5.0' });
        await run;
        expect(openExternally).toHaveBeenCalledOnce();
        expect(openExternally).toHaveBeenCalledWith('https://github.com/kubermeister/kubermeister/releases/tag/v0.5.0');
        // Reading the notes answers nothing, so the same question comes back.
        expect(messages()).toEqual([
            'Kubermeister 0.5.0 is available.',
            'Kubermeister 0.5.0 is available.',
            'Kubermeister 0.5.0 is ready to install.',
        ]);
        expect(updater.installUpdate).toHaveBeenCalledOnce();
    });

    it('does nothing more when the user picks Later, at either prompt', async () => {
        answer(2);
        await runInteractiveCheck();
        expect(updater.downloadUpdate).not.toHaveBeenCalled();
        expect(updater.installUpdate).not.toHaveBeenCalled();

        answer(0);
        answer(1);
        const run = runInteractiveCheck();
        await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledOnce());
        transition({ status: 'downloaded', version: '0.5.0' });
        await run;
        expect(updater.installUpdate).not.toHaveBeenCalled();
    });

    it('reports a download that failed instead of leaving the user waiting', async () => {
        answer(0);
        answer(0);
        const run = runInteractiveCheck();
        await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledOnce());
        transition({ status: 'error', message: 'disk full' });
        await run;
        expect(messages()[1]).toBe('The update could not be downloaded.');
        expect(boxes()[1]).toMatchObject({ detail: 'disk full', type: 'error' });
        expect(updater.installUpdate).not.toHaveBeenCalled();
    });

    it('in download mode the check starts the download itself; the restart prompt still follows', async () => {
        updater.checkForUpdates.mockImplementation(async () => {
            transition({ status: 'downloading', version: '0.5.0', percent: 0 });
            return state;
        });
        answer(0); // OK
        answer(0); // Restart Now
        const run = runInteractiveCheck();
        await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce());
        transition({ status: 'downloaded', version: '0.5.0' });
        await run;
        expect(updater.downloadUpdate).not.toHaveBeenCalled();
        expect(messages()).toEqual(['Kubermeister 0.5.0 is downloading.', 'Kubermeister 0.5.0 is ready to install.']);
        expect(updater.installUpdate).toHaveBeenCalledOnce();
    });

    it('offers the restart directly when a download is already ready, without checking again', async () => {
        state = { status: 'downloaded', version: '0.5.0' };
        answer(0);
        await runInteractiveCheck();
        expect(updater.checkForUpdates).not.toHaveBeenCalled();
        expect(messages()).toEqual(['Kubermeister 0.5.0 is ready to install.']);
        expect(updater.installUpdate).toHaveBeenCalledOnce();
    });

    it('reports the outcome of a check that found nothing, failed or cannot run', async () => {
        for (const settled of [
            { status: 'up-to-date', checkedAt: 'now' },
            { status: 'error', message: 'offline' },
            { status: 'unsupported', message: 'Development build' },
        ] satisfies UpdateState[]) {
            updater.checkForUpdates.mockResolvedValueOnce(settled);
            answer(0);
            await runInteractiveCheck();
        }
        expect(messages()).toEqual([
            'Kubermeister 0.4.0 is up to date.',
            'Kubermeister could not check for updates.',
            'This build cannot check for updates.',
        ]);
        expect(updater.downloadUpdate).not.toHaveBeenCalled();
    });

    it('falls back to any window, then to no owner, when none is focused', async () => {
        electron.BrowserWindow.getFocusedWindow.mockReturnValue(null);
        const other = { id: 'other' };
        electron.BrowserWindow.getAllWindows.mockReturnValue([other]);
        updater.checkForUpdates.mockResolvedValue({ status: 'up-to-date' });
        answer(0);
        await runInteractiveCheck();
        expect(showMessageBox.mock.calls[0]?.[0]).toBe(other);

        electron.BrowserWindow.getAllWindows.mockReturnValue([]);
        answer(0);
        await runInteractiveCheck();
        expect(showMessageBox.mock.calls[1]).toHaveLength(1);
        expect(showMessageBox.mock.calls[1]?.[0]).toMatchObject({ message: 'Kubermeister 0.4.0 is up to date.' });
    });

    it('ignores a second activation while a box is already up', async () => {
        let resolveBox: (value: { response: number }) => void = () => {};
        showMessageBox.mockReturnValueOnce(new Promise((resolve) => (resolveBox = resolve)));
        const first = runInteractiveCheck();
        await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce());
        await runInteractiveCheck();
        expect(updater.checkForUpdates).toHaveBeenCalledOnce();
        resolveBox({ response: 2 });
        await first;
        // Once the box is answered the menu item works again.
        answer(2);
        await runInteractiveCheck();
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    });
});
