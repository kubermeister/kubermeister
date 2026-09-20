import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateMode } from '../../../src/shared/settings';

const electron = { app: { isPackaged: true } };
vi.mock('electron', () => electron);

class FakeAutoUpdater extends EventEmitter {
    logger: unknown = null;
    autoDownload = true;
    autoInstallOnAppQuit = false;
    checkForUpdates = vi.fn<() => Promise<unknown>>(() => Promise.resolve(null));
    downloadUpdate = vi.fn<() => Promise<unknown>>(() => Promise.resolve([]));
    quitAndInstall = vi.fn();
}
const autoUpdater = new FakeAutoUpdater();
vi.mock('electron-updater', () => ({ default: { autoUpdater } }));

const broadcast = vi.fn();
vi.mock('../../../src/main/ipc/push.js', () => ({ broadcast }));

let mode: UpdateMode = 'check';
let checkIntervalHours = 4;
vi.mock('../../../src/main/settings/store.js', () => ({
    getSettings: () => ({ updates: { mode, checkIntervalHours } }),
}));

const savedAppImage = process.env.APPIMAGE;
let platform: NodeJS.Platform = 'darwin';
vi.spyOn(process, 'platform', 'get').mockImplementation(() => platform);

const found = {
    version: '0.3.0',
    releaseDate: '2026-09-16T06:48:44.854Z',
    releaseNotes: 'Fixes the namespace selector.',
};

const HOUR = 60 * 60 * 1000;

async function loadUpdater() {
    vi.resetModules();
    return import('../../../src/main/updater.js');
}

describe('startUpdater', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T07:00:00.000Z'));
        electron.app.isPackaged = true;
        platform = 'darwin';
        mode = 'check';
        checkIntervalHours = 4;
        delete process.env.APPIMAGE;
        autoUpdater.removeAllListeners();
        autoUpdater.autoDownload = true;
        autoUpdater.checkForUpdates.mockReset().mockResolvedValue(null);
        autoUpdater.downloadUpdate.mockReset().mockResolvedValue([]);
        autoUpdater.quitAndInstall.mockReset();
        broadcast.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
        if (savedAppImage === undefined) delete process.env.APPIMAGE;
        else process.env.APPIMAGE = savedAppImage;
    });

    it('is unsupported in development builds', async () => {
        electron.app.isPackaged = false;
        const { startUpdater, getUpdateState } = await loadUpdater();
        startUpdater();
        expect(getUpdateState()).toEqual({ status: 'unsupported', message: 'Development build' });
        expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('is unsupported for Linux installs that are not an AppImage', async () => {
        platform = 'linux';
        const { startUpdater, getUpdateState } = await loadUpdater();
        startUpdater();
        expect(getUpdateState().status).toBe('unsupported');
    });

    it('is supported for Linux AppImage installs', async () => {
        platform = 'linux';
        process.env.APPIMAGE = '/home/u/Kubermeister.AppImage';
        const { startUpdater, getUpdateState } = await loadUpdater();
        startUpdater();
        expect(getUpdateState()).toEqual({ status: 'idle' });
    });

    it('never lets the library download on its own, checks after a delay and then at the set interval', async () => {
        const { startUpdater } = await loadUpdater();
        startUpdater();
        expect(autoUpdater.autoDownload).toBe(false);
        expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
        expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(4 * HOUR - 1);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(4 * HOUR);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
    });

    it('takes the interval from settings at start', async () => {
        checkIntervalHours = 24;
        const { startUpdater } = await loadUpdater();
        startUpdater();
        await vi.advanceTimersByTimeAsync(15_000 + 12 * HOUR);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(12 * HOUR);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    });

    it('a changed interval reschedules from now; an unchanged one leaves the schedule alone', async () => {
        const { startUpdater, applyCheckInterval } = await loadUpdater();
        startUpdater();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        // Three hours into a four-hour wait, every settings write re-applies the same value: no effect.
        await vi.advanceTimersByTimeAsync(3 * HOUR);
        applyCheckInterval(4);
        await vi.advanceTimersByTimeAsync(HOUR);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
        // Lowering to one hour checks one hour from now, not at the end of the old four.
        await vi.advanceTimersByTimeAsync(2 * HOUR);
        applyCheckInterval(1);
        await vi.advanceTimersByTimeAsync(HOUR - 1);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(HOUR);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(4);
    });

    it('an interval applied to an unsupported build arms nothing', async () => {
        electron.app.isPackaged = false;
        const { startUpdater, applyCheckInterval } = await loadUpdater();
        startUpdater();
        applyCheckInterval(1);
        await vi.advanceTimersByTimeAsync(2 * HOUR);
        expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('skips scheduled checks while updates are off, but a manual check still runs', async () => {
        mode = 'off';
        const { startUpdater, checkForUpdates } = await loadUpdater();
        startUpdater();
        await vi.advanceTimersByTimeAsync(15_000 + 4 * 60 * 60 * 1000);
        expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
        await checkForUpdates();
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('in check mode reports a found version and waits for the user to download it', async () => {
        const { startUpdater, getUpdateState } = await loadUpdater();
        startUpdater();
        autoUpdater.emit('checking-for-update');
        expect(getUpdateState()).toEqual({ status: 'checking' });
        autoUpdater.emit('update-available', found);
        expect(getUpdateState()).toEqual({
            status: 'available',
            version: '0.3.0',
            releaseDate: found.releaseDate,
            notes: 'Fixes the namespace selector.',
            checkedAt: '2026-09-16T07:00:00.000Z',
        });
        expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
        // Every transition is pushed to the renderer.
        expect(broadcast).toHaveBeenLastCalledWith('update.state', getUpdateState());
    });

    it('in download mode starts the download at once without ever showing "available"', async () => {
        mode = 'download';
        const { startUpdater, getUpdateState } = await loadUpdater();
        startUpdater();
        autoUpdater.emit('update-available', found);
        expect(autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
        expect(getUpdateState()).toMatchObject({ status: 'downloading', version: '0.3.0', percent: 0 });
        expect(broadcast.mock.calls.map(([, state]) => (state as { status: string }).status)).not.toContain(
            'available',
        );
    });

    it('carries the found version through download progress to ready-to-install', async () => {
        const { startUpdater, getUpdateState, downloadUpdate } = await loadUpdater();
        startUpdater();
        autoUpdater.emit('update-available', found);
        expect(downloadUpdate()).toBe(true);
        expect(autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
        expect(getUpdateState()).toMatchObject({ status: 'downloading', version: '0.3.0', percent: 0 });
        autoUpdater.emit('download-progress', { percent: 41.6 });
        expect(getUpdateState()).toEqual({
            status: 'downloading',
            version: '0.3.0',
            releaseDate: found.releaseDate,
            notes: 'Fixes the namespace selector.',
            percent: 42,
        });
        autoUpdater.emit('update-downloaded', found);
        expect(getUpdateState()).toEqual({
            status: 'downloaded',
            version: '0.3.0',
            releaseDate: found.releaseDate,
            notes: 'Fixes the namespace selector.',
        });
    });

    it('flattens release notes GitHub hands over as HTML', async () => {
        const { startUpdater, getUpdateState } = await loadUpdater();
        startUpdater();
        autoUpdater.emit('update-available', {
            ...found,
            releaseNotes: '<h2>What\'s Changed</h2><ul><li>fix(k8s): a fix in <a href="x">#101</a></li></ul>',
        });
        expect(getUpdateState()).toMatchObject({ notes: "What's Changed\n• fix(k8s): a fix in #101" });
    });

    it('drops release notes that are not plain text', async () => {
        const { startUpdater, getUpdateState } = await loadUpdater();
        startUpdater();
        autoUpdater.emit('update-available', { ...found, releaseNotes: [{ version: '0.3.0', note: 'x' }] });
        expect(getUpdateState()).not.toHaveProperty('notes');
        autoUpdater.emit('update-available', { ...found, releaseNotes: '   ' });
        expect(getUpdateState()).not.toHaveProperty('notes');
        autoUpdater.emit('update-available', { ...found, releaseNotes: '<p></p>' });
        expect(getUpdateState()).not.toHaveProperty('notes');
    });

    it('downloads only from the available state', async () => {
        const { startUpdater, downloadUpdate } = await loadUpdater();
        startUpdater();
        expect(downloadUpdate()).toBe(false);
        autoUpdater.emit('update-not-available');
        expect(downloadUpdate()).toBe(false);
        expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    });

    it('records the time of a check that found nothing', async () => {
        const { startUpdater, getUpdateState } = await loadUpdater();
        startUpdater();
        autoUpdater.emit('update-not-available');
        expect(getUpdateState()).toEqual({ status: 'up-to-date', checkedAt: '2026-09-16T07:00:00.000Z' });
    });

    it('marks a failed scheduled check as background noise and a failed manual check as not', async () => {
        autoUpdater.checkForUpdates.mockRejectedValue(new Error('offline'));
        const { startUpdater, getUpdateState, checkForUpdates } = await loadUpdater();
        startUpdater();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(getUpdateState()).toEqual({ status: 'error', message: 'offline', background: true });
        await expect(checkForUpdates()).resolves.toEqual({ status: 'error', message: 'offline' });
    });

    it('reports library errors and a failed download as errors the user sees', async () => {
        const { startUpdater, getUpdateState, downloadUpdate } = await loadUpdater();
        startUpdater();
        autoUpdater.emit('error', new Error('feed unreachable'));
        expect(getUpdateState()).toEqual({ status: 'error', message: 'feed unreachable' });
        autoUpdater.emit('update-available', found);
        autoUpdater.downloadUpdate.mockRejectedValue('disk full');
        downloadUpdate();
        await vi.advanceTimersByTimeAsync(0);
        expect(getUpdateState()).toEqual({ status: 'error', message: 'disk full' });
    });

    it('a manual check returns the settled state and never interrupts a download in flight', async () => {
        const { startUpdater, checkForUpdates, downloadUpdate } = await loadUpdater();
        startUpdater();
        autoUpdater.checkForUpdates.mockImplementation(async () => {
            autoUpdater.emit('update-not-available');
            return null;
        });
        await expect(checkForUpdates()).resolves.toMatchObject({ status: 'up-to-date' });
        autoUpdater.emit('update-available', found);
        downloadUpdate();
        await expect(checkForUpdates()).resolves.toMatchObject({ status: 'downloading' });
        autoUpdater.emit('update-downloaded', found);
        await expect(checkForUpdates()).resolves.toMatchObject({ status: 'downloaded' });
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('a manual check in an unsupported build answers with the reason and touches nothing', async () => {
        electron.app.isPackaged = false;
        const { startUpdater, checkForUpdates } = await loadUpdater();
        startUpdater();
        await expect(checkForUpdates()).resolves.toEqual({ status: 'unsupported', message: 'Development build' });
        expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('tells in-process listeners about every transition until they unsubscribe', async () => {
        const { startUpdater, onUpdateState } = await loadUpdater();
        startUpdater();
        const seen: string[] = [];
        const stop = onUpdateState((next) => seen.push(next.status));
        autoUpdater.emit('checking-for-update');
        autoUpdater.emit('update-available', found);
        stop();
        autoUpdater.emit('update-not-available');
        expect(seen).toEqual(['checking', 'available']);
    });

    it('installs only when a download is ready', async () => {
        const { startUpdater, installUpdate } = await loadUpdater();
        startUpdater();
        expect(installUpdate()).toBe(false);
        expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
        autoUpdater.emit('update-downloaded', found);
        expect(installUpdate()).toBe(true);
        expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
    });
});
