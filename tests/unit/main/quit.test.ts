import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

/** Just enough of a `BrowserWindow` to take the close guard and replay the event at it. */
class FakeWindow {
    listeners = new Map<string, Listener[]>();
    hide = vi.fn();
    destroyed = false;
    isDestroyed = () => this.destroyed;
    on = vi.fn((event: string, listener: Listener) => {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
        return this;
    });
    /** Returns whether the close was prevented, the way Electron's own event would be read. */
    close(): boolean {
        let prevented = false;
        for (const listener of this.listeners.get('close') ?? [])
            listener({ preventDefault: () => (prevented = true) });
        return prevented;
    }
}

const appListeners = new Map<string, Listener>();
const app = {
    name: 'Kubermeister',
    quit: vi.fn(),
    on: vi.fn((event: string, listener: Listener) => appListeners.set(event, listener)),
};
let focused: FakeWindow | null = null;
let windows: FakeWindow[] = [];
const BrowserWindow = {
    getFocusedWindow: () => focused,
    getAllWindows: () => (focused ? [focused, ...windows] : windows),
};
const dialog = { showMessageBox: vi.fn() };
vi.mock('electron', () => ({ app, BrowserWindow, dialog }));

const settings = { general: { confirmQuit: true } };
const updateSettings = vi.fn();
vi.mock('../../../src/main/settings/store.js', () => ({ getSettings: () => settings, updateSettings }));

const { attachQuitConfirmation, requestQuit, watchAppQuit } = await import('../../../src/main/quit.js');

const platformWas = Object.getOwnPropertyDescriptor(process, 'platform')!;
function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/** What the dialog answers: which button, and whether the checkbox was ticked. */
function answer(response: number, checkboxChecked = false): void {
    dialog.showMessageBox.mockResolvedValue({ response, checkboxChecked });
}

const QUIT = 0;
const CANCEL = 1;

describe('confirming a quit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        appListeners.clear();
        settings.general.confirmQuit = true;
        focused = null;
        windows = [];
        setPlatform('win32');
        answer(CANCEL);
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', platformWas);
    });

    it('asks before quitting, naming what quitting ends', async () => {
        answer(QUIT);
        await requestQuit();
        const options = dialog.showMessageBox.mock.calls[0]?.at(-1) as Electron.MessageBoxOptions;
        expect(options.message).toBe('Quit Kubermeister?');
        expect(options.detail).toMatch(/port forward/i);
        expect(options.buttons).toEqual(['Quit', 'Cancel']);
        // The safe answer is the default one: macOS dismisses a sheet with its default button when
        // a second `Cmd+Q` arrives behind it, so a default of Quit would let the keystroke answer
        // its own question.
        expect(options.defaultId).toBe(CANCEL);
        expect(options.cancelId).toBe(CANCEL);
        expect(options.checkboxLabel).toBe("Don't ask again");
        expect(app.quit).toHaveBeenCalledOnce();
    });

    it('leaves everything running when the answer is Cancel', async () => {
        answer(CANCEL);
        await requestQuit();
        expect(app.quit).not.toHaveBeenCalled();
    });

    it('attaches the dialog to the window it belongs to, and stands alone without one', async () => {
        answer(QUIT);
        focused = new FakeWindow();
        await requestQuit();
        expect(dialog.showMessageBox).toHaveBeenLastCalledWith(focused, expect.any(Object));

        focused = null;
        await requestQuit();
        expect(dialog.showMessageBox).toHaveBeenLastCalledWith(expect.any(Object));
    });

    it('asks once however many times the keystroke arrives while the dialog is up', async () => {
        let settle = (_: { response: number; checkboxChecked: boolean }) => {};
        dialog.showMessageBox.mockReturnValue(new Promise((resolve) => (settle = resolve)));
        const first = requestQuit();
        await requestQuit();
        expect(dialog.showMessageBox).toHaveBeenCalledOnce();
        settle({ response: QUIT, checkboxChecked: false });
        await first;
        expect(app.quit).toHaveBeenCalledOnce();
    });

    describe('the checkbox', () => {
        it('turns the confirmation off for good when the quit goes ahead', async () => {
            answer(QUIT, true);
            await requestQuit();
            expect(updateSettings).toHaveBeenCalledWith({ general: { confirmQuit: false } });
            expect(app.quit).toHaveBeenCalledOnce();
        });

        it('writes nothing when the quit was cancelled, since nothing was agreed to', async () => {
            answer(CANCEL, true);
            await requestQuit();
            expect(updateSettings).not.toHaveBeenCalled();
        });
    });

    it('quits straight away once the confirmation is turned off', async () => {
        settings.general.confirmQuit = false;
        await requestQuit();
        expect(dialog.showMessageBox).not.toHaveBeenCalled();
        expect(app.quit).toHaveBeenCalledOnce();
    });

    describe('closing the window', () => {
        it('asks where closing the window is quitting the app', async () => {
            answer(QUIT);
            const window = new FakeWindow();
            attachQuitConfirmation(window as unknown as Electron.BrowserWindow);
            expect(window.close()).toBe(true);
            await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
        });

        it('leaves the app running on a cancelled close', async () => {
            answer(CANCEL);
            const window = new FakeWindow();
            attachQuitConfirmation(window as unknown as Electron.BrowserWindow);
            expect(window.close()).toBe(true);
            await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledOnce());
            expect(app.quit).not.toHaveBeenCalled();
        });

        it('does not ask on macOS, where closing the window is not quitting', () => {
            setPlatform('darwin');
            const window = new FakeWindow();
            attachQuitConfirmation(window as unknown as Electron.BrowserWindow);
            expect(window.close()).toBe(false);
            expect(dialog.showMessageBox).not.toHaveBeenCalled();
        });

        it('takes the windows off screen as the quit starts, so none is left empty and white', () => {
            const live = new FakeWindow();
            const gone = new FakeWindow();
            gone.destroyed = true;
            windows = [live, gone];
            watchAppQuit();
            appListeners.get('before-quit')?.();
            expect(live.hide).toHaveBeenCalledOnce();
            expect(gone.hide).not.toHaveBeenCalled();
        });

        it('does not ask again for the windows a quit already under way is closing', () => {
            const window = new FakeWindow();
            attachQuitConfirmation(window as unknown as Electron.BrowserWindow);
            watchAppQuit();
            // Every path to `app.quit()` raises this first, the confirmed quit included, so the
            // windows it then closes are not a second question.
            appListeners.get('before-quit')?.();
            expect(window.close()).toBe(false);
            expect(dialog.showMessageBox).not.toHaveBeenCalled();
        });
    });
});
