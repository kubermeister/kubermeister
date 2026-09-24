import { resolve } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { DEEP_LINK_SCHEME, deepLinkInArgv, parseDeepLink, type DeepLink } from '../shared/deep-link.js';
import { broadcast } from './ipc/push.js';

/**
 * The link the OS handed over last, parsed, until the renderer takes it. Only the latest is kept:
 * two links clicked in a row mean the second, and a queue would open screens nobody is waiting for.
 */
let pending: DeepLink | null = null;

/** How a link that finds no window opens one; unset until startup has made the first window. */
let openWindow: (() => void) | undefined;

/** Answer the waiting link and forget it, so it is opened once whoever asks. */
export function takeDeepLink(): DeepLink | null {
    const link = pending;
    pending = null;
    return link;
}

/**
 * A link is outside input: it is parsed here, where a malformed one is refused with a reason, and
 * the renderer only ever hears that one is waiting. It never acts on anything by itself; what it
 * becomes is a navigation, and a context switch only once the user has said yes.
 */
export function receiveDeepLink(url: string): void {
    pending = parseDeepLink(url);
    bringForward();
    broadcast('deep-link', {});
}

/**
 * Show the window the link is for. On macOS the app outlives its last window, so a link clicked
 * then needs a new one. Until startup has made its first window there is nothing to show, and that
 * window takes the link when its renderer mounts.
 */
function bringForward(): void {
    if (!openWindow) return;
    const [window] = BrowserWindow.getAllWindows();
    if (!window) {
        openWindow();
        return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
}

/**
 * One instance per user-data directory: a second launch, which is how Windows and Linux open a link
 * while the app runs, hands its arguments to this one through `second-instance` and quits. Answers
 * whether this launch is the one that carries on. The lock is keyed on `userData`, so the path must
 * be settled before this runs, which is what keeps the end-to-end runs, each with its own directory,
 * from quitting one another.
 */
export function claimSingleInstance(): boolean {
    if (app.requestSingleInstanceLock()) return true;
    app.quit();
    return false;
}

/**
 * Listen for links however the OS delivers them. macOS sends `open-url`, which can fire before the
 * app is ready, so this runs at startup rather than once a window exists; Windows and Linux put
 * the link in `argv`, of the first launch and of every later one handed over by `second-instance`.
 * A second launch without a link still brings the running window forward, since that is what
 * starting an app that is already open means.
 */
export function watchDeepLinks(argv: readonly string[] = process.argv): void {
    app.on('open-url', (event, url) => {
        event.preventDefault();
        receiveDeepLink(url);
    });
    app.on('second-instance', (_event, secondArgv) => {
        const url = deepLinkInArgv(secondArgv);
        if (url) receiveDeepLink(url);
        else bringForward();
    });
    const first = deepLinkInArgv(argv);
    if (first) receiveDeepLink(first);
    registerDevelopmentProtocol();
}

/** Startup has made its first window: from now on a link brings a window forward, or opens one. */
export function showWindowsForDeepLinks(open: () => void): void {
    openWindow = open;
}

/**
 * A packaged build is registered for the scheme by its installer (`protocols` in
 * `electron-builder.yml`, the Linux desktop entry). `npm run dev` has no installer, so on Windows
 * and Linux it registers itself, passing the app path Electron needs to be started with. Only the
 * dev server does this: an end-to-end run also starts unpackaged, and it must never take the scheme
 * away from the Kubermeister installed on the machine running it.
 *
 * macOS ignores the path and the arguments and binds the scheme to the running bundle, which in
 * development is the stock `Electron.app` every Electron checkout shares: a link then starts a bare
 * Electron that shows its empty default window, and the binding goes on taking links from an
 * installed Kubermeister. So a macOS dev run registers nothing and takes back a binding an earlier
 * one left; links are tried there against `npm run package:dir`, whose bundle has its own id.
 */
function registerDevelopmentProtocol(): void {
    if (app.isPackaged || !process.env.ELECTRON_RENDERER_URL) return;
    if (process.platform === 'darwin') {
        if (app.isDefaultProtocolClient(DEEP_LINK_SCHEME)) app.removeAsDefaultProtocolClient(DEEP_LINK_SCHEME);
        return;
    }
    const entry = process.argv[1];
    if (entry) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [resolve(entry)]);
}
