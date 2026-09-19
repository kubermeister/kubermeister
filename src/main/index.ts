import { app, BrowserWindow, screen, shell } from 'electron';
import { join } from 'node:path';
import { registerHandlers } from './ipc/index.js';
import { setReadTimeoutSec } from './k8s/errors.js';
import { registerStreamHandlers, stopAllStreams } from './ipc/streams.js';
import { stopSampler } from './k8s/sampler.js';
import { installApplicationMenu } from './menu.js';
import { isExternalWebUrl, isInternalNavigation } from './security.js';
import { getSettings, updateSettings } from './settings/store.js';
import { adoptLoginShellPath } from './shell-path.js';
import { startUpdater } from './updater.js';
import { usableBounds } from './window-bounds.js';

// Tests redirect all per-user state (settings, caches) into a throwaway directory so the real
// installation is never read or written.
if (process.env.KUBERMEISTER_USER_DATA) app.setPath('userData', process.env.KUBERMEISTER_USER_DATA);

// Packaged builds take their name from electron-builder's productName, which also names their
// settings folder. Only development, which runs from Electron's own bundle, needs the name set by
// hand.
if (!app.isPackaged) app.setName('Kubermeister');

// A kubeconfig written by `aws eks update-kubeconfig` names its credential plugin by bare command,
// which a Finder or Dock launch cannot find under launchd's PATH. The login shell's PATH is looked
// up while Electron starts and awaited before any IPC handler can reach the cluster.
const shellPathReady = adoptLoginShellPath();

function createWindow(): BrowserWindow {
    // Reading the screen needs the app to be ready, which it is by the time a window is created.
    const saved = getSettings().window.bounds;
    const bounds = saved ? usableBounds(saved, screen.getDisplayMatching(saved).workArea) : undefined;
    const window = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        ...(bounds ?? {}),
        webPreferences: {
            preload: join(__dirname, '../preload/index.cjs'),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    // End-to-end runs on a developer machine show the window without taking focus, so keystrokes
    // meant for the terminal never land in the app under test.
    // Remember where the window stood, so the next launch opens it in the same place.
    window.on('close', () => updateSettings({ window: { bounds: window.getBounds() } }));

    window.on('ready-to-show', () => (process.env.KUBERMEISTER_SHOW_INACTIVE ? window.showInactive() : window.show()));

    window.webContents.setWindowOpenHandler(({ url }) => {
        if (isExternalWebUrl(url)) void shell.openExternal(url);
        return { action: 'deny' };
    });

    const guardNavigation = (event: Electron.Event, url: string): void => {
        if (isInternalNavigation(url, process.env.ELECTRON_RENDERER_URL)) return;
        event.preventDefault();
        if (isExternalWebUrl(url)) void shell.openExternal(url);
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

void app.whenReady().then(async () => {
    await shellPathReady;
    // The read ceiling is a setting; apply the saved one before the first cluster call can run.
    setReadTimeoutSec(getSettings().data.readTimeoutSec);
    installApplicationMenu();
    registerHandlers();
    registerStreamHandlers();
    startUpdater();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('will-quit', () => {
    stopAllStreams();
    stopSampler();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
