import { app, BrowserWindow } from 'electron';
import { registerHandlers } from './ipc/index.js';
import { setReadTimeoutSec } from './k8s/errors.js';
import { registerStreamHandlers, stopAllStreams } from './ipc/streams.js';
import { stopSampler } from './k8s/sampler.js';
import { installApplicationMenu } from './menu.js';
import { getSettings } from './settings/store.js';
import { adoptLoginShellEnv } from './shell-env.js';
import { startUpdater } from './updater.js';
import { createMainWindow } from './window.js';

// Tests redirect all per-user state (settings, caches) into a throwaway directory so the real
// installation is never read or written.
if (process.env.KUBERMEISTER_USER_DATA) app.setPath('userData', process.env.KUBERMEISTER_USER_DATA);

// Packaged builds take their name from electron-builder's productName, which also names their
// settings folder. Only development, which runs from Electron's own bundle, needs the name set by
// hand.
if (!app.isPackaged) app.setName('Kubermeister');

// A kubeconfig written by `aws eks update-kubeconfig` names its credential plugin by bare command,
// which a Finder or Dock launch cannot find under launchd's PATH, and the same launch carries none
// of the proxy variables the user's shell sets. Both are looked up while Electron starts and
// awaited before any IPC handler can reach the cluster.
const shellEnvReady = adoptLoginShellEnv();

void app.whenReady().then(async () => {
    await shellEnvReady;
    // The read ceiling is a setting; apply the saved one before the first cluster call can run.
    setReadTimeoutSec(getSettings().data.readTimeoutSec);
    installApplicationMenu();
    registerHandlers();
    registerStreamHandlers();
    startUpdater();
    createMainWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

app.on('will-quit', () => {
    stopAllStreams();
    stopSampler();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
