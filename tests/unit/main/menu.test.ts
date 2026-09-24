import type { MenuItemConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const menu = { buildFromTemplate: vi.fn((template: unknown) => ({ template })), setApplicationMenu: vi.fn() };
vi.mock('electron', () => ({ app: { name: 'Kubermeister', getVersion: () => '0.4.9' }, Menu: menu }));
const broadcast = vi.fn();
vi.mock('../../../src/main/ipc/push.js', () => ({ broadcast }));
const requestQuit = vi.fn(() => Promise.resolve());
vi.mock('../../../src/main/quit.js', () => ({ requestQuit }));
const runInteractiveCheck = vi.fn(() => Promise.resolve());
vi.mock('../../../src/main/update-dialog.js', () => ({ runInteractiveCheck }));
const openExternally = vi.fn();
vi.mock('../../../src/main/window.js', () => ({ openExternally }));

const { buildMenuTemplate, installApplicationMenu } = await import('../../../src/main/menu.js');
const { SHORTCUTS, chordAccelerator, platformOf } = await import('../../../src/shared/shortcuts.js');

const labels = (items: MenuItemConstructorOptions[] | undefined) =>
    (items ?? []).map((i) => i.label ?? i.role ?? i.type);
const settingsItem = (template: MenuItemConstructorOptions[]) =>
    (template[0]?.submenu as MenuItemConstructorOptions[]).find((i) => i.label === 'Settings…')!;
const updatesItem = (template: MenuItemConstructorOptions[]) =>
    (template[0]?.submenu as MenuItemConstructorOptions[]).find((i) => i.label === 'Check for Updates…')!;
const quitItem = (template: MenuItemConstructorOptions[]) =>
    (template[0]?.submenu as MenuItemConstructorOptions[]).at(-1)!;

describe('application menu', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('puts Settings with the Cmd+, accelerator in the app menu on macOS', () => {
        const template = buildMenuTemplate('darwin');
        expect(template[0]?.label).toBe('Kubermeister');
        expect(labels(template[0]?.submenu as MenuItemConstructorOptions[])).toContain('Settings…');
        expect(labels(template[0]?.submenu as MenuItemConstructorOptions[]).at(-1)).toBe('Quit Kubermeister');
        expect(labels(template[0]?.submenu as MenuItemConstructorOptions[]).slice(0, 2)).toEqual([
            'about',
            'Check for Updates…',
        ]);
        expect(settingsItem(template).accelerator).toBe('Cmd+,');
        expect(template.slice(1).map((i) => i.role ?? i.label)).toEqual(['editMenu', 'View', 'windowMenu', 'help']);
    });

    it('puts Settings with the Ctrl+, key in a File menu elsewhere', () => {
        for (const platform of ['linux', 'win32'] as const) {
            const template = buildMenuTemplate(platform);
            expect(template[0]?.label).toBe('File');
            expect(labels(template[0]?.submenu as MenuItemConstructorOptions[])).toEqual([
                'Settings…',
                'Check for Updates…',
                'separator',
                'Quit',
            ]);
            // The renderer answers the key, so it works wherever the page does.
            expect(settingsItem(template)).toMatchObject({ accelerator: 'Ctrl+,', registerAccelerator: false });
        }
    });

    it('asks before quitting, from the item ⌘Q triggers as well as from a click', () => {
        // A `role: 'quit'` item would quit by itself; this one is spelled out so the keystroke and
        // the click meet the same question, with the accelerator still shown beside the label.
        const mac = quitItem(buildMenuTemplate('darwin'));
        expect(mac.role).toBeUndefined();
        expect(mac.accelerator).toBe('Cmd+Q');
        (mac.click as () => void)();
        const other = quitItem(buildMenuTemplate('win32'));
        expect(other.accelerator).toBeUndefined();
        (other.click as () => void)();
        expect(requestQuit).toHaveBeenCalledTimes(2);
    });

    it('pushes open-settings to the renderer when Settings is activated', () => {
        const item = settingsItem(buildMenuTemplate('darwin'));
        (item.click as () => void)();
        expect(broadcast).toHaveBeenCalledWith('open-settings', {});
    });

    it('runs the native update flow, not Settings, when Check for Updates is activated', () => {
        for (const platform of ['darwin', 'win32'] as const) {
            const item = updatesItem(buildMenuTemplate(platform));
            (item.click as () => void)();
        }
        expect(runInteractiveCheck).toHaveBeenCalledTimes(2);
        // The flow must not depend on a renderer that can open Settings.
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('offers a prefilled bug report and the repository from the Help menu on every platform', () => {
        for (const platform of ['darwin', 'linux', 'win32'] as const) {
            const template = buildMenuTemplate(platform);
            const help = template.at(-1)!;
            expect(help.role).toBe('help');
            const items = help.submenu as MenuItemConstructorOptions[];
            expect(labels(items)).toEqual([
                'Keyboard Shortcuts',
                'separator',
                'Report a Bug…',
                'Kubermeister on GitHub',
            ]);

            openExternally.mockClear();
            (items[2]?.click as () => void)();
            const [url] = openExternally.mock.calls[0] as [string];
            const params = new URL(url).searchParams;
            expect(params.get('template')).toBe('bug_report.yml');
            expect(params.get('version')).toBe('0.4.9');

            (items[3]?.click as () => void)();
            expect(openExternally).toHaveBeenLastCalledWith('https://github.com/kubermeister/kubermeister');
        }
        // A report needs no renderer: the menu opens the browser itself.
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('opens the cheat sheet from Help › Keyboard Shortcuts through the renderer', () => {
        const help = buildMenuTemplate('linux').at(-1)!;
        const item = (help.submenu as MenuItemConstructorOptions[])[0]!;
        expect(item).toMatchObject({ accelerator: '?', registerAccelerator: false });
        (item.click as () => void)();
        expect(broadcast).toHaveBeenCalledWith('shortcut', { id: 'cheatSheet' });
    });

    it('spells out the View menu, whose Mod+R refreshes the data instead of reloading the window', () => {
        for (const platform of ['darwin', 'linux', 'win32'] as const) {
            const view = buildMenuTemplate(platform).find((i) => i.label === 'View')!;
            const items = view.submenu as MenuItemConstructorOptions[];
            expect(items.map((i) => i.label ?? i.role ?? i.type)).toEqual([
                'Refresh',
                'forceReload',
                'toggleDevTools',
                'separator',
                'resetZoom',
                'zoomIn',
                'zoomOut',
                'separator',
                'togglefullscreen',
            ]);
            expect(items.some((i) => i.role === 'reload')).toBe(false);
            const mod = platform === 'darwin' ? 'Cmd' : 'Ctrl';
            expect(items[0]).toMatchObject({ accelerator: `${mod}+R`, registerAccelerator: false });
            // Force Reload is the one key main keeps: the window starts afresh without a page to ask.
            expect(items[1]).toEqual({ role: 'forceReload', accelerator: `${mod}+Shift+R` });
            (items[0]?.click as () => void)();
        }
        expect(broadcast).toHaveBeenCalledTimes(3);
        expect(broadcast).toHaveBeenCalledWith('shortcut', { id: 'refresh' });
    });

    it('closes through the Close role on Windows and Linux, so the close guard still asks', () => {
        for (const platform of ['linux', 'win32'] as const) {
            const windowMenu = buildMenuTemplate(platform).find((i) => i.label === 'Window')!;
            expect(windowMenu.submenu).toEqual([{ role: 'minimize' }, { role: 'close', accelerator: 'Ctrl+W' }]);
        }
        expect(buildMenuTemplate('darwin').find((i) => i.role === 'windowMenu')).toBeDefined();
    });

    it('takes every accelerator from the shortcut table and registers only the menu-handled ones', () => {
        const walk = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
            items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? walk(i.submenu) : [])]);
        for (const platform of ['darwin', 'linux', 'win32'] as const) {
            const table = SHORTCUTS.flatMap((s) => {
                const chord = s.keys[platformOf(platform)][0];
                return chord
                    ? [{ accelerator: chordAccelerator(chord, platformOf(platform)), handler: s.handler }]
                    : [];
            });
            const withKeys = walk(buildMenuTemplate(platform)).filter((i) => i.accelerator);
            expect(withKeys.length).toBeGreaterThan(0);
            for (const item of withKeys) {
                const entry = table.find((t) => t.accelerator === item.accelerator);
                expect(entry, `${String(item.label ?? item.role)} on ${platform}`).toBeDefined();
                expect(item.registerAccelerator === false).toBe(entry!.handler === 'renderer');
            }
        }
    });

    it('installs the built menu for the current platform', () => {
        installApplicationMenu();
        expect(menu.buildFromTemplate).toHaveBeenCalledOnce();
        expect(menu.setApplicationMenu).toHaveBeenCalledWith({ template: expect.any(Array) });
    });
});
