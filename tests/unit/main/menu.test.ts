import type { MenuItemConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const menu = { buildFromTemplate: vi.fn((template: unknown) => ({ template })), setApplicationMenu: vi.fn() };
vi.mock('electron', () => ({ app: { name: 'Kubermeister', getVersion: () => '0.4.9' }, Menu: menu }));
const broadcast = vi.fn();
vi.mock('../../../src/main/ipc/push.js', () => ({ broadcast }));
const runInteractiveCheck = vi.fn(() => Promise.resolve());
vi.mock('../../../src/main/update-dialog.js', () => ({ runInteractiveCheck }));
const openExternally = vi.fn();
vi.mock('../../../src/main/window.js', () => ({ openExternally }));

const { buildMenuTemplate, installApplicationMenu } = await import('../../../src/main/menu.js');

const labels = (items: MenuItemConstructorOptions[] | undefined) =>
    (items ?? []).map((i) => i.label ?? i.role ?? i.type);
const settingsItem = (template: MenuItemConstructorOptions[]) =>
    (template[0]?.submenu as MenuItemConstructorOptions[]).find((i) => i.label === 'Settings…')!;
const updatesItem = (template: MenuItemConstructorOptions[]) =>
    (template[0]?.submenu as MenuItemConstructorOptions[]).find((i) => i.label === 'Check for Updates…')!;

describe('application menu', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('puts Settings with the Cmd+, accelerator in the app menu on macOS', () => {
        const template = buildMenuTemplate('darwin');
        expect(template[0]?.label).toBe('Kubermeister');
        expect(labels(template[0]?.submenu as MenuItemConstructorOptions[])).toContain('Settings…');
        expect(labels(template[0]?.submenu as MenuItemConstructorOptions[]).slice(0, 2)).toEqual([
            'about',
            'Check for Updates…',
        ]);
        expect(settingsItem(template).accelerator).toBe('Cmd+,');
        expect(template.slice(1).map((i) => i.role)).toEqual(['editMenu', 'viewMenu', 'windowMenu', 'help']);
    });

    it('puts Settings without an accelerator in a File menu elsewhere', () => {
        for (const platform of ['linux', 'win32'] as const) {
            const template = buildMenuTemplate(platform);
            expect(template[0]?.label).toBe('File');
            expect(labels(template[0]?.submenu as MenuItemConstructorOptions[])).toEqual([
                'Settings…',
                'Check for Updates…',
                'separator',
                'quit',
            ]);
            expect(settingsItem(template).accelerator).toBeUndefined();
        }
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
            expect(labels(items)).toEqual(['Report a Bug…', 'Kubermeister on GitHub']);

            openExternally.mockClear();
            (items[0]?.click as () => void)();
            const [url] = openExternally.mock.calls[0] as [string];
            const params = new URL(url).searchParams;
            expect(params.get('template')).toBe('bug_report.yml');
            expect(params.get('version')).toBe('0.4.9');

            (items[1]?.click as () => void)();
            expect(openExternally).toHaveBeenLastCalledWith('https://github.com/kubermeister/kubermeister');
        }
        // A report needs no renderer: the menu opens the browser itself.
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('installs the built menu for the current platform', () => {
        installApplicationMenu();
        expect(menu.buildFromTemplate).toHaveBeenCalledOnce();
        expect(menu.setApplicationMenu).toHaveBeenCalledWith({ template: expect.any(Array) });
    });
});
