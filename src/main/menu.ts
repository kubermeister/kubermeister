import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { bugReportUrl } from '../shared/bug-report.js';
import { chordAccelerator, platformOf, shortcutById, type ShortcutId } from '../shared/shortcuts.js';
import { REPOSITORY_URL } from '../shared/updates.js';
import { broadcast } from './ipc/push.js';
import { requestQuit } from './quit.js';
import { runInteractiveCheck } from './update-dialog.js';
import { openExternally } from './window.js';

/**
 * The application menu. Its Settings item shows `Cmd+,` or `Ctrl+,`, and activating it pushes
 * `open-settings`, which the renderer routes to the settings screen. "Check for
 * Updates…" runs the native dialog flow in main rather than opening Settings, so it works even when
 * the renderer is stuck behind the startup checks and has no Settings to open. The Help menu is
 * there for the same reason: a bug worth reporting is often one that left no renderer to report it
 * from, and both its items are URLs the OS browser opens through the app's own external-link guard.
 *
 * Quit is spelled out rather than taken from `role: 'quit'`, because a role quits by itself and
 * this one has to ask first. The item is what `Cmd+Q` triggers, so the keystroke and the click are
 * one path and the accelerator still shows beside the label.
 *
 * Every accelerator here comes from the shortcut table in `src/shared/shortcuts.ts`. A registered
 * accelerator runs when the page leaves its key unhandled, which is why a focused terminal, which
 * cancels every key it sends to the shell, keeps `Ctrl+R` and `Ctrl+W`. A key the renderer handles
 * itself is shown beside its item without being registered, because the renderer also declines
 * keys on purpose (a dialog is open, the editor binds the key) and a registered accelerator would
 * act on exactly those. The View menu is spelled out so its first item refreshes the screen's data
 * rather than reloading the window.
 */
export function buildMenuTemplate(platform: NodeJS.Platform = process.platform): MenuItemConstructorOptions[] {
    const isMac = platform === 'darwin';
    const keys = (id: ShortcutId): Pick<MenuItemConstructorOptions, 'accelerator' | 'registerAccelerator'> => {
        const shortcut = shortcutById(id);
        const chord = shortcut.keys[platformOf(platform)][0];
        if (!chord) return {};
        const accelerator = chordAccelerator(chord, platformOf(platform));
        return shortcut.handler === 'renderer' ? { accelerator, registerAccelerator: false } : { accelerator };
    };
    const settingsItem: MenuItemConstructorOptions = {
        label: 'Settings…',
        ...keys('settings'),
        click: () => broadcast('open-settings', {}),
    };
    const updatesItem: MenuItemConstructorOptions = {
        label: 'Check for Updates…',
        click: () => void runInteractiveCheck(),
    };
    const quitItem: MenuItemConstructorOptions = {
        label: isMac ? `Quit ${app.name}` : 'Quit',
        ...keys('quit'),
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
    const view: MenuItemConstructorOptions = {
        label: 'View',
        submenu: [
            { label: 'Refresh', ...keys('refresh'), click: () => broadcast('shortcut', { id: 'refresh' }) },
            { role: 'forceReload', ...keys('forceReload') },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
        ],
    };
    // macOS's Window menu has no Close item. Elsewhere Close is the role's own, which runs the
    // window's close guard; spelled out only so its key is the table's.
    const window: MenuItemConstructorOptions = isMac
        ? { role: 'windowMenu' }
        : { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close', ...keys('closeWindow') }] };
    const help: MenuItemConstructorOptions = {
        role: 'help',
        submenu: [
            {
                label: 'Keyboard Shortcuts',
                ...keys('cheatSheet'),
                click: () => broadcast('shortcut', { id: 'cheatSheet' }),
            },
            { type: 'separator' },
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
    return [first, { role: 'editMenu' }, view, window, help];
}

export function installApplicationMenu(): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}
