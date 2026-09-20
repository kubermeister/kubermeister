import { app } from 'electron';
import electronUpdater, { type UpdateInfo } from 'electron-updater';
import type { UpdateState } from '../shared/ipc.js';
import { broadcast } from './ipc/push.js';
import { getSettings } from './settings/store.js';

// electron-updater is CommonJS; named imports are not reliably detected from ESM, so destructure.
const { autoUpdater } = electronUpdater;

const FIRST_CHECK_DELAY_MS = 15_000;
const HOUR_MS = 60 * 60 * 1000;

let state: UpdateState = { status: 'idle' };
const listeners = new Set<(state: UpdateState) => void>();

function setState(next: UpdateState): void {
    state = next;
    broadcast('update.state', next);
    for (const listener of listeners) listener(next);
}

/**
 * Hear every transition inside main, the way the renderer hears `update.state`. The native update
 * dialog waits on a download this way, since it must work when no renderer is listening.
 */
export function onUpdateState(listener: (state: UpdateState) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function now(): string {
    return new Date().toISOString();
}

/**
 * The fields that describe a found version, kept through download and readiness. The feed's own
 * release notes are left where they are: the app shows the release page rather than a changelog.
 */
function describe(info: UpdateInfo): Pick<UpdateState, 'version' | 'releaseDate'> {
    return { version: info.version, releaseDate: info.releaseDate };
}

function carry(current: UpdateState): Pick<UpdateState, 'version' | 'releaseDate'> {
    const { version, releaseDate } = current;
    return { version, releaseDate };
}

/**
 * Why the updater cannot run in this build, or `null` when it can. The update feed (the GitHub
 * releases of this repository) is embedded by electron-builder at package time, so development
 * builds have nothing to check against. Linux deb packages are managed by apt and only
 * the AppImage can replace itself.
 */
function unsupportedReason(): string | null {
    if (!app.isPackaged) return 'Development build';
    if (process.platform === 'linux' && !process.env.APPIMAGE) return 'Installed from a .deb package';
    return null;
}

function mode() {
    return getSettings().updates.mode;
}

let checkIntervalMs = 0;
let nextCheck: NodeJS.Timeout | undefined;
let scheduling = false;

/** Arm the next scheduled check `delayMs` from now; each check arms the one after it at the interval. */
function scheduleNext(delayMs: number, run: () => void): void {
    clearTimeout(nextCheck);
    nextCheck = setTimeout(() => {
        run();
        scheduleNext(checkIntervalMs, run);
    }, delayMs);
}

let runScheduled: () => void = () => {};

/**
 * Apply the `updates.checkIntervalHours` setting. A changed interval reschedules the next check from
 * now, so lowering it does not wait out the old one; an unchanged value leaves the schedule alone,
 * because every settings write passes through here (window bounds, a remembered forward) and none
 * of those should push the next check further out.
 */
export function applyCheckInterval(hours: number): void {
    const ms = hours * HOUR_MS;
    if (ms === checkIntervalMs) return;
    checkIntervalMs = ms;
    if (scheduling) scheduleNext(ms, runScheduled);
}

/**
 * Checks on a delay after launch and then at the interval the settings name, unless updates are
 * off. The library never downloads on its own: `updates.mode` decides at the moment a version is
 * found whether the download starts or waits for the user, so changing the setting needs no restart.
 * A downloaded update installs on quit; the renderer can also ask for an immediate restart through
 * `installUpdate`.
 */
export function startUpdater(): void {
    const reason = unsupportedReason();
    if (reason) {
        setState({ status: 'unsupported', message: reason });
        return;
    }

    autoUpdater.logger = console;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }));
    autoUpdater.on('update-not-available', () => setState({ status: 'up-to-date', checkedAt: now() }));
    autoUpdater.on('update-available', (info) => {
        const available: UpdateState = { status: 'available', ...describe(info), checkedAt: now() };
        if (mode() === 'download') {
            // The user asked for silent downloads: never announce a version they need not act on.
            state = available;
            downloadUpdate();
        } else {
            setState(available);
        }
    });
    autoUpdater.on('download-progress', (progress) =>
        setState({ status: 'downloading', ...carry(state), percent: Math.round(progress.percent) }),
    );
    autoUpdater.on('update-downloaded', (info) => setState({ status: 'downloaded', ...describe(info) }));
    autoUpdater.on('error', (error) => setState({ status: 'error', message: errorMessage(error) }));

    runScheduled = (): void => {
        if (mode() === 'off') return;
        void runCheck().catch((error: unknown) => {
            // Nobody asked for this check; the failure is recorded, not announced.
            setState({ status: 'error', message: errorMessage(error), background: true });
        });
    };
    checkIntervalMs = getSettings().updates.checkIntervalHours * HOUR_MS;
    scheduling = true;
    scheduleNext(FIRST_CHECK_DELAY_MS, runScheduled);
}

function busy(): boolean {
    return state.status === 'unsupported' || state.status === 'downloading' || state.status === 'downloaded';
}

/** Checks unless a download is in flight or ready; rejects when the feed cannot be read. */
async function runCheck(): Promise<void> {
    if (busy()) return;
    await autoUpdater.checkForUpdates();
}

export function getUpdateState(): UpdateState {
    return state;
}

/** A check the user asked for, from Settings or the menu. Resolves to the state once the check settled. */
export async function checkForUpdates(): Promise<UpdateState> {
    try {
        await runCheck();
    } catch (error) {
        setState({ status: 'error', message: errorMessage(error) });
    }
    return state;
}

/** Starts downloading the found version. Returns false when there is nothing to download. */
export function downloadUpdate(): boolean {
    if (state.status !== 'available') return false;
    setState({ status: 'downloading', ...carry(state), percent: 0 });
    autoUpdater.downloadUpdate().catch((error: unknown) => {
        setState({ status: 'error', message: errorMessage(error) });
    });
    return true;
}

/** Quits and installs a downloaded update. Returns false when nothing is ready. */
export function installUpdate(): boolean {
    if (state.status !== 'downloaded') return false;
    autoUpdater.quitAndInstall();
    return true;
}
