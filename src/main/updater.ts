import { app } from 'electron';
import electronUpdater, { type UpdateInfo } from 'electron-updater';
import { load as loadYaml } from 'js-yaml';
import type { UpdateState } from '../shared/ipc.js';
import { DEFAULT_UPDATE_MODE } from '../shared/settings.js';
import { compareVersions, releaseFeedUrl } from '../shared/updates.js';
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
 * Why there is nothing to check against, or `null` when there is. Only a development build is in
 * that position: the update feed is the GitHub releases of this repository, which a build made on
 * somebody's machine was never published to.
 */
function unsupportedReason(): string | null {
    return app.isPackaged ? null : 'Development build';
}

/**
 * Whether this install can replace itself. Only the AppImage can on Linux, and its runtime is what
 * sets `APPIMAGE`; a deb, an rpm or an AUR package belongs to the system's own package manager, and
 * an app that overwrote its files would leave that manager's database describing something else.
 */
function installsItself(): boolean {
    return process.platform !== 'linux' || !!process.env.APPIMAGE;
}

/** Said of an install the system's package manager owns, wherever the found version is shown. */
const MANUAL_MESSAGE =
    'This package is managed by the system, so the new version is installed the same way as this one.';

/** How long the published feed has to answer before a check gives up. */
const FEED_TIMEOUT_MS = 15_000;

/**
 * The version the releases page is offering. Read from the published feed rather than through
 * electron-updater, which declines to look at all when it could not install what it found:
 * `AppImageUpdater.isUpdaterActive()` is false without `APPIMAGE`, and `checkForUpdates` bails on
 * that. Knowing a version exists needs no package manager, so it is answered separately.
 */
async function publishedVersion(): Promise<string> {
    const response = await fetch(releaseFeedUrl(process.platform), {
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        headers: { accept: 'text/yaml, text/plain' },
    });
    if (!response.ok) throw new Error(`The release feed answered ${response.status}.`);
    const feed: unknown = loadYaml(await response.text());
    const version = typeof feed === 'object' && feed !== null ? (feed as { version?: unknown }).version : undefined;
    if (typeof version !== 'string' || version.trim() === '') throw new Error('The release feed named no version.');
    return version;
}

/** The check for an install that cannot replace itself: report the version, never fetch it. */
async function checkPublished(): Promise<void> {
    setState({ status: 'checking' });
    const version = await publishedVersion();
    if (compareVersions(version, app.getVersion()) <= 0) {
        setState({ status: 'up-to-date', checkedAt: now() });
        return;
    }
    setState({ status: 'manual', version, checkedAt: now(), message: MANUAL_MESSAGE });
}

function mode() {
    return getSettings().updates.mode ?? DEFAULT_UPDATE_MODE;
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

    // An install the system owns gets the scheduling below and the feed check, and none of the
    // library's wiring: nothing here may download or install for it.
    if (installsItself()) wireAutoUpdater();

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

function wireAutoUpdater(): void {
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
        setState({
            status: 'downloading',
            ...carry(state),
            percent: Math.round(progress.percent),
            transferred: progress.transferred,
            total: progress.total,
        }),
    );
    autoUpdater.on('update-downloaded', (info) => setState({ status: 'downloaded', ...describe(info) }));
    autoUpdater.on('error', (error) => setState({ status: 'error', message: errorMessage(error) }));
}

function busy(): boolean {
    return state.status === 'unsupported' || state.status === 'downloading' || state.status === 'downloaded';
}

/** Checks unless a download is in flight or ready; rejects when the feed cannot be read. */
async function runCheck(): Promise<void> {
    if (busy()) return;
    if (!installsItself()) {
        await checkPublished();
        return;
    }
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
