import { app, BrowserWindow, screen, shell } from 'electron';
import { join } from 'node:path';
import { attachQuitConfirmation } from './quit.js';
import { isExternalWebUrl, isInternalNavigation } from './security.js';
import { getSettings, updateSettings } from './settings/store.js';
import { usableBounds } from './window-bounds.js';

/**
 * The renderer runs untrusted-by-default: sandboxed, isolated from the preload's world, without
 * Node. It reaches main only through the bridge the preload exposes. None of this is ever relaxed;
 * `tests/unit/main/window.test.ts` locks it in.
 */
export const WEB_PREFERENCES: Electron.WebPreferences = {
    preload: join(__dirname, '../preload/index.cjs'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
};

/**
 * A URL the page tried to open or navigate to goes to the OS browser when it is a web URL and is
 * dropped otherwise, so a compromised renderer can neither open a second window that inherits the
 * bridge nor hand a `file:` or `javascript:` URL to the OS.
 */
export function openExternally(url: string): void {
    if (isExternalWebUrl(url)) void shell.openExternal(url);
}

/**
 * Linux is the only platform where the window has to carry its own icon: macOS takes it from the
 * `.app` bundle and Windows from the executable's resources, while a Linux window with none of its
 * own falls back to the desktop's placeholder unless the shell can match it to an installed desktop
 * entry — and an AppImage installs no entry at all until the user integrates it. The PNG rides
 * along as an extra resource because `files` packages nothing but `out/`.
 */
export function windowIcon(): string | undefined {
    if (process.platform !== 'linux') return undefined;
    return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../resources/icon.png');
}

export function createMainWindow(): BrowserWindow {
    // Reading the screen needs the app to be ready, which it is by the time a window is created.
    const saved = getSettings().window.bounds;
    const bounds = saved ? usableBounds(saved, screen.getDisplayMatching(saved).workArea) : undefined;
    const icon = windowIcon();
    const window = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        ...(icon ? { icon } : {}),
        ...(bounds ?? {}),
        webPreferences: WEB_PREFERENCES,
    });

    // Remember where the window stood, so the next launch opens it in the same place.
    window.on('close', () => updateSettings({ window: { bounds: window.getBounds() } }));

    // End-to-end runs on a developer machine show the window without taking focus, so keystrokes
    // meant for the terminal never land in the app under test.
    window.on('ready-to-show', () => (process.env.KUBERMEISTER_SHOW_INACTIVE ? window.showInactive() : window.show()));

    // Where closing the window quits the app, closing it asks first.
    attachQuitConfirmation(window);

    window.webContents.setWindowOpenHandler(({ url }) => {
        openExternally(url);
        return { action: 'deny' };
    });

    const guardNavigation = (event: Electron.Event, url: string): void => {
        if (isInternalNavigation(url, process.env.ELECTRON_RENDERER_URL)) return;
        event.preventDefault();
        openExternally(url);
    };
    window.webContents.on('will-navigate', guardNavigation);
    window.webContents.on('will-redirect', guardNavigation);

    if (process.env.ELECTRON_RENDERER_URL) {
        void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
        void window.loadFile(join(__dirname, '../renderer/index.html'));
    }

    return window;
}
