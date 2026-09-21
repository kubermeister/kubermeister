import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => unknown;

class FakeWebContents {
    listeners = new Map<string, Listener>();
    openHandler: ((details: { url: string }) => { action: string }) | undefined;
    setWindowOpenHandler = vi.fn((handler: (details: { url: string }) => { action: string }) => {
        this.openHandler = handler;
    });
    on = vi.fn((event: string, listener: Listener) => {
        this.listeners.set(event, listener);
        return this;
    });
}

class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    webContents = new FakeWebContents();
    listeners = new Map<string, Listener>();
    show = vi.fn();
    showInactive = vi.fn();
    loadURL = vi.fn(() => Promise.resolve());
    loadFile = vi.fn(() => Promise.resolve());
    getBounds = vi.fn(() => ({ x: 10, y: 20, width: 800, height: 600 }));
    constructor(public options: Record<string, unknown>) {
        FakeBrowserWindow.instances.push(this);
    }
    on(event: string, listener: Listener): this {
        this.listeners.set(event, listener);
        return this;
    }
    emit(event: string, ...args: unknown[]): void {
        this.listeners.get(event)?.(...args);
    }
}

const shell = { openExternal: vi.fn(() => Promise.resolve()) };
const screen = { getDisplayMatching: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })) };
const app = { isPackaged: false };
vi.mock('electron', () => ({ app, BrowserWindow: FakeBrowserWindow, screen, shell }));

const settings = { window: { bounds: null as { x: number; y: number; width: number; height: number } | null } };
const getSettings = vi.fn(() => settings);
const updateSettings = vi.fn();
vi.mock('../../../src/main/settings/store.js', () => ({ getSettings, updateSettings }));

const { createMainWindow, WEB_PREFERENCES, windowIcon } = await import('../../../src/main/window.js');

/** Neither the platform nor the unpacked resource directory is Electron's under Vitest. */
function onPlatform(platform: NodeJS.Platform, resourcesPath: string, run: () => void): void {
    const platformWas = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const resourcesWas = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true });
    try {
        run();
    } finally {
        Object.defineProperty(process, 'platform', platformWas);
        if (resourcesWas) Object.defineProperty(process, 'resourcesPath', resourcesWas);
        else delete (process as { resourcesPath?: string }).resourcesPath;
    }
}

function create(): FakeBrowserWindow {
    createMainWindow();
    return FakeBrowserWindow.instances.at(-1)!;
}

function navigate(
    window: FakeBrowserWindow,
    event: 'will-navigate' | 'will-redirect',
    url: string,
): { prevented: boolean } {
    const prevented = { prevented: false };
    window.webContents.listeners.get(event)!({ preventDefault: () => (prevented.prevented = true) }, url);
    return prevented;
}

describe('the main window', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        FakeBrowserWindow.instances = [];
        settings.window.bounds = null;
        app.isPackaged = false;
        delete process.env.ELECTRON_RENDERER_URL;
        delete process.env.KUBERMEISTER_SHOW_INACTIVE;
    });

    afterEach(() => {
        delete process.env.ELECTRON_RENDERER_URL;
        delete process.env.KUBERMEISTER_SHOW_INACTIVE;
    });

    describe('renderer hardening', () => {
        it('runs the renderer sandboxed, isolated and without node', () => {
            const window = create();
            expect(window.options.webPreferences).toBe(WEB_PREFERENCES);
            expect(WEB_PREFERENCES).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
            expect(WEB_PREFERENCES.preload).toMatch(/preload[/\\]index\.cjs$/);
            // Nothing else may be set: every other web preference default is the safe one.
            expect(Object.keys(WEB_PREFERENCES).sort()).toEqual([
                'contextIsolation',
                'nodeIntegration',
                'preload',
                'sandbox',
            ]);
        });

        it('never opens a second window, and hands only web URLs to the OS browser', () => {
            const window = create();
            const handler = window.webContents.openHandler!;
            expect(handler({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' });
            expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/docs');
            shell.openExternal.mockClear();
            for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'kubermeister://x', 'not a url']) {
                expect(handler({ url })).toEqual({ action: 'deny' });
            }
            expect(shell.openExternal).not.toHaveBeenCalled();
        });

        it('lets the packaged document navigate itself and blocks everything else', () => {
            const window = create();
            expect(navigate(window, 'will-navigate', 'file:///app/out/renderer/index.html#/pods').prevented).toBe(
                false,
            );
            expect(navigate(window, 'will-navigate', 'https://example.com').prevented).toBe(true);
            expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
            shell.openExternal.mockClear();
            expect(navigate(window, 'will-redirect', 'javascript:alert(1)').prevented).toBe(true);
            expect(navigate(window, 'will-redirect', 'http://localhost:5173/').prevented).toBe(true);
            expect(shell.openExternal).toHaveBeenCalledTimes(1);
            expect(shell.openExternal).toHaveBeenCalledWith('http://localhost:5173/');
        });

        it('treats only the dev server as internal while developing', () => {
            process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/';
            const window = create();
            expect(window.loadURL).toHaveBeenCalledWith('http://localhost:5173/');
            expect(window.loadFile).not.toHaveBeenCalled();
            expect(navigate(window, 'will-navigate', 'http://localhost:5173/#/nodes').prevented).toBe(false);
            expect(navigate(window, 'will-navigate', 'file:///app/out/renderer/index.html').prevented).toBe(true);
            expect(shell.openExternal).not.toHaveBeenCalled();
        });
    });

    describe('the icon', () => {
        it('gives the Linux window the packaged PNG, since nothing else carries one there', () => {
            app.isPackaged = true;
            onPlatform('linux', '/opt/Kubermeister/resources', () => {
                expect(windowIcon()).toBe('/opt/Kubermeister/resources/icon.png');
                expect(create().options.icon).toBe('/opt/Kubermeister/resources/icon.png');
            });
        });

        it('reads it from the repository while developing, where there is no resource directory', () => {
            onPlatform('linux', '/unused', () => {
                expect(windowIcon()).toMatch(/[/\\]resources[/\\]icon\.png$/);
                expect(windowIcon()).not.toContain('/unused');
            });
        });

        it('sets none on macOS and Windows, which take it from the bundle', () => {
            for (const platform of ['darwin', 'win32'] as const) {
                onPlatform(platform, '/unused', () => {
                    expect(windowIcon()).toBeUndefined();
                    expect(create().options).not.toHaveProperty('icon');
                });
            }
        });
    });

    describe('placement', () => {
        it('loads the packaged document and opens at the default size when nothing was saved', () => {
            const window = create();
            expect(window.loadFile).toHaveBeenCalledWith(expect.stringMatching(/renderer[/\\]index\.html$/));
            expect(window.options).toMatchObject({ width: 1200, height: 800, show: false });
            expect(window.options).not.toHaveProperty('x');
            expect(screen.getDisplayMatching).not.toHaveBeenCalled();
        });

        it('reopens where it was closed when those bounds are still on a display', () => {
            settings.window.bounds = { x: 100, y: 80, width: 1000, height: 700 };
            const window = create();
            expect(screen.getDisplayMatching).toHaveBeenCalledWith(settings.window.bounds);
            expect(window.options).toMatchObject(settings.window.bounds);
        });

        it('falls back to the default size when the saved bounds are off every display', () => {
            settings.window.bounds = { x: 5000, y: 80, width: 1000, height: 700 };
            const window = create();
            expect(window.options).toMatchObject({ width: 1200, height: 800 });
            expect(window.options).not.toHaveProperty('x');
        });

        it('remembers its bounds on close', () => {
            const window = create();
            window.emit('close');
            expect(updateSettings).toHaveBeenCalledWith({
                window: { bounds: { x: 10, y: 20, width: 800, height: 600 } },
            });
        });

        it('shows itself when ready, without focus under the end-to-end flag', () => {
            const window = create();
            window.emit('ready-to-show');
            expect(window.show).toHaveBeenCalledTimes(1);
            expect(window.showInactive).not.toHaveBeenCalled();

            process.env.KUBERMEISTER_SHOW_INACTIVE = '1';
            const inactive = create();
            inactive.emit('ready-to-show');
            expect(inactive.showInactive).toHaveBeenCalledTimes(1);
            expect(inactive.show).not.toHaveBeenCalled();
        });
    });
});
