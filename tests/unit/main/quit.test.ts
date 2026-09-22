import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

/** Just enough of a `WebContents` to receive the guard's listeners and replay events at it. */
class FakeWebContents {
    listeners = new Map<string, Listener[]>();
    on = vi.fn((event: string, listener: Listener) => {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
        return this;
    });
    emit(event: string, ...args: unknown[]): void {
        for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
}

const app = { quit: vi.fn() };
vi.mock('electron', () => ({ app }));
const broadcast = vi.fn();
vi.mock('../../../src/main/ipc/push.js', () => ({ broadcast }));
const settings = { general: { holdToQuit: true } };
vi.mock('../../../src/main/settings/store.js', () => ({ getSettings: () => settings }));

const { attachHoldToQuit, HOLD_TO_QUIT_MS, setQuitOverlayReady } = await import('../../../src/main/quit.js');

const platformWas = Object.getOwnPropertyDescriptor(process, 'platform')!;
function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/** A key event as Chromium delivers it, defaulting to ⌘Q going down. */
function press(
    contents: FakeWebContents,
    input: Record<string, unknown> = {},
): { preventDefault: ReturnType<typeof vi.fn> } {
    const event = { preventDefault: vi.fn() };
    contents.emit('before-input-event', event, {
        type: 'keyDown',
        key: 'q',
        meta: true,
        control: false,
        alt: false,
        shift: false,
        ...input,
    });
    return event;
}

/** Attach the guard to a fresh renderer that has said it can show the hint. */
function guarded(ready = true): FakeWebContents {
    const contents = new FakeWebContents();
    attachHoldToQuit(contents as unknown as Electron.WebContents);
    setQuitOverlayReady(ready);
    return contents;
}

describe('hold ⌘Q to quit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        setPlatform('darwin');
        settings.general.holdToQuit = true;
        setQuitOverlayReady(false);
    });

    afterEach(() => {
        vi.useRealTimers();
        Object.defineProperty(process, 'platform', platformWas);
    });

    it('swallows the keystroke, shows the hint and quits once the keys have been held', () => {
        const contents = guarded();
        const event = press(contents);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(broadcast).toHaveBeenCalledWith('quit.hold', { holding: true });

        vi.advanceTimersByTime(HOLD_TO_QUIT_MS - 1);
        expect(app.quit).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(app.quit).toHaveBeenCalledOnce();
    });

    it('reads the repeats the held keys send as the one hold they are', () => {
        const contents = guarded();
        press(contents);
        vi.advanceTimersByTime(HOLD_TO_QUIT_MS - 100);
        press(contents, { isAutoRepeat: true });
        expect(broadcast).toHaveBeenCalledOnce();
        // The hold is still the first one's: a repeat that restarted it would never come due.
        vi.advanceTimersByTime(100);
        expect(app.quit).toHaveBeenCalledOnce();
    });

    it('cancels and fades the hint when the keys go early', () => {
        const contents = guarded();
        press(contents);
        vi.advanceTimersByTime(HOLD_TO_QUIT_MS / 2);
        // macOS withholds the `q` release while Command is down, so the Command release is what
        // every cancelled hold has in common.
        press(contents, { type: 'keyUp', key: 'Meta' });
        expect(broadcast).toHaveBeenLastCalledWith('quit.hold', { holding: false });
        vi.advanceTimersByTime(HOLD_TO_QUIT_MS);
        expect(app.quit).not.toHaveBeenCalled();
    });

    it('cancels when the window loses focus mid-hold, since the release lands elsewhere', () => {
        const contents = guarded();
        press(contents);
        contents.emit('blur');
        expect(broadcast).toHaveBeenLastCalledWith('quit.hold', { holding: false });
        vi.advanceTimersByTime(HOLD_TO_QUIT_MS);
        expect(app.quit).not.toHaveBeenCalled();
    });

    it('cancels when another key is pressed while the keys are down', () => {
        const contents = guarded();
        press(contents);
        press(contents, { key: 'w' });
        expect(broadcast).toHaveBeenLastCalledWith('quit.hold', { holding: false });
        vi.advanceTimersByTime(HOLD_TO_QUIT_MS);
        expect(app.quit).not.toHaveBeenCalled();
    });

    it('leaves every other keystroke to the page', () => {
        const contents = guarded();
        for (const input of [
            { key: 'w' },
            { key: 'q', meta: false },
            { key: 'q', shift: true },
            { key: 'q', control: true },
            { key: 'q', alt: true },
            { type: 'keyUp', key: 'Meta' },
        ]) {
            expect(press(contents, input).preventDefault).not.toHaveBeenCalled();
        }
        expect(broadcast).not.toHaveBeenCalled();
        vi.advanceTimersByTime(HOLD_TO_QUIT_MS);
        expect(app.quit).not.toHaveBeenCalled();
    });

    describe('failing open', () => {
        it('lets the keystroke reach the menu accelerator when the setting is off', () => {
            settings.general.holdToQuit = false;
            const event = press(guarded());
            // Not prevented: the menu item's own ⌘Q quits, as it did before the guard existed.
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(broadcast).not.toHaveBeenCalled();
            expect(app.quit).not.toHaveBeenCalled();
        });

        it('lets it through while the renderer has no hint to show', () => {
            const event = press(guarded(false));
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(broadcast).not.toHaveBeenCalled();
        });

        it('lets it through again once the document the hint belonged to is gone', () => {
            for (const gone of ['did-navigate', 'render-process-gone', 'destroyed']) {
                const contents = guarded();
                contents.emit(gone);
                expect(press(contents).preventDefault).not.toHaveBeenCalled();
            }
            expect(broadcast).not.toHaveBeenCalled();
        });

        it('drops a hold in flight when the hint goes with its renderer', () => {
            const contents = guarded();
            press(contents);
            contents.emit('destroyed');
            vi.advanceTimersByTime(HOLD_TO_QUIT_MS);
            expect(app.quit).not.toHaveBeenCalled();
        });

        it('stays armed across the routing the app does within its one document', () => {
            const contents = guarded();
            // Every screen change is a hash navigation; a guard that took those for a new
            // document would be off from the first click on.
            contents.emit('did-navigate-in-page');
            contents.emit('did-start-loading');
            expect(press(contents).preventDefault).toHaveBeenCalledOnce();
        });

        it('guards nothing off macOS, where ⌘Q is not the near-miss it is here', () => {
            for (const platform of ['linux', 'win32'] as const) {
                setPlatform(platform);
                const contents = new FakeWebContents();
                attachHoldToQuit(contents as unknown as Electron.WebContents);
                expect(contents.on).not.toHaveBeenCalled();
            }
        });
    });
});
