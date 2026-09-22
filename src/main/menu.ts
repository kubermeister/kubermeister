import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { bugReportUrl } from '../shared/bug-report.js';
import { REPOSITORY_URL } from '../shared/updates.js';
import { broadcast } from './ipc/push.js';
import { requestQuit } from './quit.js';
import { runInteractiveCheck } from './update-dialog.js';
import { openExternally } from './window.js';

/**
 * The application menu. Its Settings item carries the standard macOS `Cmd+,` accelerator, so the
 * visible entry and the shortcut come from one mechanism; other platforms open Settings by click.
 * Activating it pushes `open-settings`, which the renderer routes to the settings screen. "Check for
 * Updates…" runs the native dialog flow in main rather than opening Settings, so it works even when
 * the renderer is stuck behind the startup checks and has no Settings to open. The Help menu is
 * there for the same reason: a bug worth reporting is often one that left no renderer to report it
 * from, and both its items are URLs the OS browser opens through the app's own external-link guard.
 *
 * Quit is spelled out rather than taken from `role: 'quit'`, because a role quits by itself and
 * this one has to ask first. The item is what `Cmd+Q` triggers, so the keystroke and the click are
 * one path and the accelerator still shows beside the label.
 */
export function buildMenuTemplate(platform: NodeJS.Platform = process.platform): MenuItemConstructorOptions[] {
    const isMac = platform === 'darwin';
    const settingsItem: MenuItemConstructorOptions = {
        label: 'Settings…',
        ...(isMac ? { accelerator: 'Cmd+,' } : {}),
        click: () => broadcast('open-settings', {}),
    };
    const updatesItem: MenuItemConstructorOptions = {
        label: 'Check for Updates…',
        click: () => void runInteractiveCheck(),
    };
    const quitItem: MenuItemConstructorOptions = {
        label: isMac ? `Quit ${app.name}` : 'Quit',
        ...(isMac ? { accelerator: 'Cmd+Q' } : {}),
        click: () => void requestQuit(),
    };
    const first: MenuItemConstructorOptions = isMac
        ? {
              label: app.name,
              submenu: [
                  { role: 'about' },
                  updatesItem,
                  { type: 'separator' },
                  settingsItem,
                  { type: 'separator' },
                  { role: 'services' },
                  { type: 'separator' },
                  { role: 'hide' },
                  { role: 'hideOthers' },
                  { role: 'unhide' },
                  { type: 'separator' },
                  quitItem,
              ],
          }
        : { label: 'File', submenu: [settingsItem, updatesItem, { type: 'separator' }, quitItem] };
    const help: MenuItemConstructorOptions = {
        role: 'help',
        submenu: [
            {
                label: 'Report a Bug…',
                click: () =>
                    openExternally(
                        bugReportUrl({
                            version: app.getVersion(),
                            platform: process.platform,
                            arch: process.arch,
                            electron: process.versions.electron,
                            chrome: process.versions.chrome,
                            node: process.versions.node,
                        }),
                    ),
            },
            { label: 'Kubermeister on GitHub', click: () => openExternally(REPOSITORY_URL) },
        ],
    };
    return [first, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }, help];
}

export function installApplicationMenu(): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}
