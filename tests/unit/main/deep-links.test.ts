import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

class FakeWindow {
    minimized = false;
    isMinimized = vi.fn(() => this.minimized);
    restore = vi.fn();
    show = vi.fn();
    focus = vi.fn();
}

const listeners = new Map<string, Listener>();
const windows: FakeWindow[] = [];
const app = {
    isPackaged: false,
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    setAsDefaultProtocolClient: vi.fn(),
    isDefaultProtocolClient: vi.fn(() => false),
    removeAsDefaultProtocolClient: vi.fn(),
    on: vi.fn((event: string, listener: Listener) => {
        listeners.set(event, listener);
        return app;
    }),
};
vi.mock('electron', () => ({ app, BrowserWindow: { getAllWindows: () => windows } }));

const broadcast = vi.fn();
vi.mock('../../../src/main/ipc/push.js', () => ({ broadcast }));

type DeepLinks = typeof import('../../../src/main/deep-links.js');

/** A fresh module per test: which listeners it registered and what it holds are per launch. */
async function load(): Promise<DeepLinks> {
    vi.resetModules();
    return import('../../../src/main/deep-links.js');
}

function emit(event: string, ...args: unknown[]): void {
    const listener = listeners.get(event);
    if (!listener) throw new Error(`nothing listens for ${event}`);
    listener(...args);
}

/** Electron's platform is Node's, which Vitest does not let a test choose. */
async function onPlatform(platform: NodeJS.Platform, run: () => Promise<void>): Promise<void> {
    const was = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
        await run();
    } finally {
        Object.defineProperty(process, 'platform', was);
    }
}

const LINK = 'kubermeister://open/prod-eu/workloads/pods/default/web-1/logs';

describe('the single-instance lock', () => {
    beforeEach(() => {
        app.requestSingleInstanceLock.mockReset();
        app.quit.mockReset();
    });

    it('lets the first launch carry on', async () => {
        app.requestSingleInstanceLock.mockReturnValue(true);
        const { claimSingleInstance } = await load();
        expect(claimSingleInstance()).toBe(true);
        expect(app.quit).not.toHaveBeenCalled();
    });

    it('quits a second launch, whose arguments reach the first through second-instance', async () => {
        app.requestSingleInstanceLock.mockReturnValue(false);
        const { claimSingleInstance } = await load();
        expect(claimSingleInstance()).toBe(false);
        expect(app.quit).toHaveBeenCalledOnce();
    });
});

describe('receiving a link', () => {
    const openWindow = vi.fn();

    beforeEach(() => {
        listeners.clear();
        windows.length = 0;
        openWindow.mockReset();
        broadcast.mockReset();
        app.setAsDefaultProtocolClient.mockReset();
        app.isDefaultProtocolClient.mockReset();
        app.isDefaultProtocolClient.mockReturnValue(false);
        app.removeAsDefaultProtocolClient.mockReset();
        delete process.env.ELECTRON_RENDERER_URL;
    });

    afterEach(() => {
        delete process.env.ELECTRON_RENDERER_URL;
    });

    it('holds a link macOS delivers through open-url before any window exists', async () => {
        const { takeDeepLink, watchDeepLinks } = await load();
        watchDeepLinks([]);
        const event = { preventDefault: vi.fn() };
        emit('open-url', event, LINK);
        expect(event.preventDefault).toHaveBeenCalled();
        // No window to show and none opened: the one startup creates takes the link when it mounts.
        expect(openWindow).not.toHaveBeenCalled();
        expect(takeDeepLink()).toEqual({
            ok: true,
            context: 'prod-eu',
            path: '/workloads/pods/default/web-1/logs',
        });
    });

    it('answers a link once, so a reload does not open it again', async () => {
        const { takeDeepLink, watchDeepLinks } = await load();
        watchDeepLinks([]);
        emit('open-url', { preventDefault: vi.fn() }, LINK);
        expect(takeDeepLink()).not.toBeNull();
        expect(takeDeepLink()).toBeNull();
    });

    it('keeps only the latest of two links', async () => {
        const { takeDeepLink, watchDeepLinks } = await load();
        watchDeepLinks([]);
        emit('open-url', { preventDefault: vi.fn() }, LINK);
        emit('open-url', { preventDefault: vi.fn() }, 'kubermeister://open/dev/workloads/pods');
        expect(takeDeepLink()).toMatchObject({ context: 'dev', path: '/workloads/pods' });
        expect(takeDeepLink()).toBeNull();
    });

    it('reads the link a Windows or Linux launch carries in argv', async () => {
        const { takeDeepLink, watchDeepLinks } = await load();
        watchDeepLinks(['/opt/Kubermeister/kubermeister', LINK]);
        expect(takeDeepLink()).toMatchObject({ ok: true, context: 'prod-eu' });
    });

    it('takes the link out of a second launch’s argv and brings the window forward', async () => {
        const { showWindowsForDeepLinks, takeDeepLink, watchDeepLinks } = await load();
        const window = new FakeWindow();
        window.minimized = true;
        windows.push(window);
        watchDeepLinks([]);
        showWindowsForDeepLinks(openWindow);
        emit('second-instance', {}, ['C:\\Kubermeister\\Kubermeister.exe', LINK], 'C:\\');
        expect(window.restore).toHaveBeenCalled();
        expect(window.focus).toHaveBeenCalled();
        expect(openWindow).not.toHaveBeenCalled();
        expect(broadcast).toHaveBeenCalledWith('deep-link', {});
        expect(takeDeepLink()).toMatchObject({ ok: true, path: '/workloads/pods/default/web-1/logs' });
    });

    it('brings the window forward for a second launch without a link, and holds nothing', async () => {
        const { showWindowsForDeepLinks, takeDeepLink, watchDeepLinks } = await load();
        const window = new FakeWindow();
        windows.push(window);
        watchDeepLinks([]);
        showWindowsForDeepLinks(openWindow);
        emit('second-instance', {}, ['kubermeister'], '/');
        expect(window.focus).toHaveBeenCalled();
        expect(broadcast).not.toHaveBeenCalled();
        expect(takeDeepLink()).toBeNull();
    });

    it('opens a window for a link that arrives once the last one has closed', async () => {
        const { showWindowsForDeepLinks, watchDeepLinks } = await load();
        watchDeepLinks([]);
        showWindowsForDeepLinks(openWindow);
        emit('open-url', { preventDefault: vi.fn() }, LINK);
        expect(openWindow).toHaveBeenCalledOnce();
    });

    it('holds a malformed link as a refusal the renderer can say, never as a path', async () => {
        const { takeDeepLink, watchDeepLinks } = await load();
        watchDeepLinks([]);
        emit('open-url', { preventDefault: vi.fn() }, 'kubermeister://open/dev/../../etc');
        expect(takeDeepLink()).toMatchObject({ ok: false, reason: expect.any(String) });
    });

    it('registers the scheme for the dev server only, with the app path to start', async () => {
        await onPlatform('linux', async () => {
            const { watchDeepLinks } = await load();
            watchDeepLinks([]);
            expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();

            process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';
            const again = await load();
            again.watchDeepLinks([]);
            expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith(
                'kubermeister',
                process.execPath,
                expect.any(Array),
            );
        });
    });

    it('never registers the dev server on macOS, which would bind the stock Electron bundle', async () => {
        await onPlatform('darwin', async () => {
            process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';
            const { watchDeepLinks } = await load();
            watchDeepLinks([]);
            expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
            expect(app.removeAsDefaultProtocolClient).not.toHaveBeenCalled();
        });
    });

    it('takes back a macOS registration an earlier dev run left on the stock Electron bundle', async () => {
        await onPlatform('darwin', async () => {
            process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';
            app.isDefaultProtocolClient.mockReturnValue(true);
            const { watchDeepLinks } = await load();
            watchDeepLinks([]);
            expect(app.removeAsDefaultProtocolClient).toHaveBeenCalledWith('kubermeister');
        });
    });
});
