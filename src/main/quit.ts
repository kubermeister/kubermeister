import { app, type WebContents } from 'electron';
import { broadcast } from './ipc/push.js';
import { getSettings } from './settings/store.js';

/**
 * Quitting is expensive here: `will-quit` stops every stream, so a mistyped `Cmd+Q` — one key from
 * `Cmd+W` — takes the port forwards, the shell open in a pod, every log follow and a drain running
 * against a node, none of which come back on the next launch. So the keystroke is made a deliberate
 * one the way Chrome makes it: a tap shows a hint, and the app quits only once the keys have been
 * held. Only the keystroke is guarded — the menu item, the updater's restart and a shutdown the OS
 * asks for all still quit at once, since each is already a deliberate act.
 *
 * The decision is main's and the hint is the renderer's, so the two are separate: main hears the
 * keys through `before-input-event` (which runs before the menu accelerator it then swallows) and
 * pushes `quit.hold`, while the renderer only draws what it is told. That makes the guard
 * conditional on there being a renderer to draw it, which is the point of {@link setQuitOverlayReady}:
 * with no window, or with a renderer that never mounted, the keystroke is left alone and the menu's
 * own accelerator quits as it always did, rather than waiting on a hint nobody can see.
 */

/** How long the keys must stay down. About a second, as Chrome's own hold is. */
export const HOLD_TO_QUIT_MS = 1_000;

/** Whether a renderer is mounted and listening for the hint. Reset whenever its document goes. */
let overlayReady = false;
let holdTimer: NodeJS.Timeout | null = null;

/**
 * The renderer reports whether its hint is mounted. A document that goes — a reload, a crash, a
 * closed window — takes the hint with it, so the guard is off again until the next one says so.
 */
export function setQuitOverlayReady(ready: boolean): void {
    overlayReady = ready;
    if (!ready) cancelHold();
}

/** ⌘Q alone: ⌘⇧Q is the system's log-out and ⌃/⌥ make it somebody else's shortcut. */
function isQuitChord(input: Electron.Input): boolean {
    return input.meta && !input.control && !input.alt && !input.shift && input.key.toLowerCase() === 'q';
}

function cancelHold(): void {
    if (!holdTimer) return;
    clearTimeout(holdTimer);
    holdTimer = null;
    broadcast('quit.hold', { holding: false });
}

function startHold(): void {
    broadcast('quit.hold', { holding: true });
    holdTimer = setTimeout(() => {
        holdTimer = null;
        app.quit();
    }, HOLD_TO_QUIT_MS);
}

function handleInput(event: Electron.Event, input: Electron.Input): void {
    if (input.type !== 'keyDown') {
        // The `q` release never arrives while Command is down, so the Command release is what
        // ends most holds; either one means the gesture is over.
        if (input.key === 'Meta' || input.key.toLowerCase() === 'q') cancelHold();
        return;
    }
    if (!isQuitChord(input)) {
        cancelHold();
        return;
    }
    if (!overlayReady || !getSettings().general.holdToQuit) return;
    event.preventDefault();
    // The keys repeat while they are held; the hold is the first press, not the latest one.
    if (!holdTimer) startHold();
}

/**
 * Guard the keystroke on one renderer. macOS only: Windows and Linux quit from the close button
 * and `Alt+F4`, neither of which sits beside the shortcut for closing a tab.
 */
export function attachHoldToQuit(contents: WebContents): void {
    if (process.platform !== 'darwin') return;
    contents.on('before-input-event', handleInput);
    // The release lands wherever focus went, so a hold that outlives focus would quit unasked.
    contents.on('blur', cancelHold);
    // A hint lives as long as the document holding it, and no longer: a reload, a crashed
    // renderer or a closed window leaves the keystroke unguarded until the next hint says it is
    // there. Routing is not that — the app navigates by hash within the one document, and a guard
    // that disarmed on every screen change would be off almost always.
    contents.on('did-navigate', () => setQuitOverlayReady(false));
    contents.on('render-process-gone', () => setQuitOverlayReady(false));
    contents.on('destroyed', () => setQuitOverlayReady(false));
}
