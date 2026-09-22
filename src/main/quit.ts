import { app, BrowserWindow, dialog } from 'electron';
import { getSettings, updateSettings } from './settings/store.js';

/**
 * Quitting is expensive here: `will-quit` stops every stream, so it takes the port forwards, the
 * shell open in a pod, every log follow and a drain running against a node, and none of them come
 * back on the next launch. So quitting asks first, through a native dialog rather than anything in
 * the renderer: the question has to be answerable when a renderer never mounted, and it is main
 * that quits.
 *
 * It asks on the two paths the user takes: the Quit menu item, which is also what the `Cmd+Q`
 * accelerator triggers, and the window's own close where closing means quitting. Nothing here
 * touches `before-quit` beyond listening to it: the updater's restart and a shutdown the OS asks
 * for both reach `app.quit()` without the menu, and neither is a moment to put a modal in front of.
 */

/** Set once the app is on its way out, so the windows a quit closes are not a second question. */
let quitting = false;
/** Set while the dialog is up, so a second `Cmd+Q` behind it does not stack another one. */
let asking = false;

/**
 * Listen for the app quitting by any route at all. Registered once at startup, before a window
 * exists, since a quit can begin before one does.
 */
export function watchAppQuit(): void {
    app.on('before-quit', () => {
        quitting = true;
        // Electron takes a moment to tear down after the app's own shutdown is done, and a window
        // left on screen through it is an empty white one that reads as a crash rather than as a
        // close. Hiding them makes the app go when it is asked to, and the rest finishes out of
        // sight. Nothing here vetoes a quit, so a hidden window can never be a running app that
        // merely looks shut.
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.hide();
        }
    });
}

/**
 * Ask, unless the user has said not to. The checkbox is acted on only when the answer is Quit: a
 * cancelled action is a poor moment to write a preference nobody agreed to.
 */
async function confirmQuit(parent: BrowserWindow | null): Promise<boolean> {
    if (!getSettings().general.confirmQuit) return true;
    if (asking) return false;
    const options: Electron.MessageBoxOptions = {
        type: 'question',
        buttons: ['Quit', 'Cancel'],
        // Cancel is the default because macOS answers a sheet with its default button when
        // something else asks for attention — a second `Cmd+Q` behind it does exactly that — and a
        // keystroke that answers the question it raised would be no question at all. Quitting is
        // therefore the button that has to be chosen, and Return, Escape and a stray repeat all
        // leave everything running.
        defaultId: 1,
        cancelId: 1,
        message: `Quit ${app.name}?`,
        detail: 'Port forwards, shell sessions, log follows and any drain in progress end with the app, and none of them are restored on the next launch.',
        checkboxLabel: "Don't ask again",
        checkboxChecked: false,
    };
    asking = true;
    try {
        const { response, checkboxChecked } = parent
            ? await dialog.showMessageBox(parent, options)
            : await dialog.showMessageBox(options);
        if (response !== 0) return false;
        if (checkboxChecked) updateSettings({ general: { confirmQuit: false } });
        return true;
    } finally {
        asking = false;
    }
}

/** The window the dialog belongs to: the one in use, or the only one there is. */
function parentWindow(): BrowserWindow | null {
    return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

/** The Quit menu item, and so the accelerator that triggers that very item. */
export async function requestQuit(): Promise<void> {
    if (await confirmQuit(parentWindow())) app.quit();
}

/**
 * Guard the window's own close. Windows and Linux quit with the last window, by the close button
 * or `Alt+F4`, so closing it is a quit and asks like one; on macOS the app outlives its window,
 * so closing one loses nothing that opening it again does not bring back.
 */
export function attachQuitConfirmation(window: BrowserWindow): void {
    if (process.platform === 'darwin') return;
    window.on('close', (event) => {
        if (quitting) return;
        event.preventDefault();
        void confirmQuit(window).then((confirmed) => {
            if (confirmed) app.quit();
        });
    });
}
