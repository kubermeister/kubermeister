import { app, BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import type { UpdateState } from '../shared/ipc.js';
import { checkForUpdates, downloadUpdate, getUpdateState, installUpdate, onUpdateState } from './updater.js';

/**
 * The native update flow behind the menu's "Check for Updates…". The top-bar pill and the Settings
 * card only exist once the renderer has mounted past the startup checks; a kubeconfig that will not
 * load, a white screen or a crashed renderer leaves them unreachable, and an update found in that
 * state has nowhere to show. This flow needs no renderer: the outcome of the check, the download
 * and the restart are all message boxes owned by main, so the way out of a broken install is never
 * itself behind the thing that broke.
 */

/** What the leading button of a prompt does; the other button always dismisses. */
export type PromptAction = 'download' | 'install' | 'dismiss';

export interface UpdatePrompt {
    type: 'info' | 'error';
    message: string;
    detail?: string;
    /** The leading button first; the last button is what Escape and closing the box mean. */
    buttons: string[];
    action: PromptAction;
}

/** Release notes beyond this are the changelog, which the release page shows in full. */
const MAX_NOTES = 600;

function excerpt(notes: string | undefined): string {
    if (!notes) return '';
    return notes.length > MAX_NOTES ? `${notes.slice(0, MAX_NOTES - 1).trimEnd()}…` : notes;
}

function releasedOn(iso: string | undefined): string {
    if (!iso) return '';
    const date = Date.parse(iso);
    if (Number.isNaN(date)) return '';
    return `Released ${new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}.`;
}

/** "Kubermeister 0.4.0" or, for a state that lost its version, just the name. */
function named(version: string | undefined): string {
    return version ? `Kubermeister ${version}` : 'Kubermeister';
}

function paragraphs(...parts: string[]): string | undefined {
    const text = parts.filter((part) => part.length > 0).join('\n\n');
    return text.length > 0 ? text : undefined;
}

/** The message box for a settled updater state, as seen by a user on `currentVersion`. */
export function promptFor(state: UpdateState, currentVersion: string): UpdatePrompt {
    switch (state.status) {
        case 'available':
            return {
                type: 'info',
                message: `${named(state.version)} is available.`,
                detail: paragraphs(`You have ${currentVersion}.`, releasedOn(state.releaseDate), excerpt(state.notes)),
                buttons: ['Download', 'Later'],
                action: 'download',
            };
        case 'downloading':
            return {
                type: 'info',
                message: `${named(state.version)} is downloading.`,
                detail: 'You will be asked to restart once it is ready.',
                buttons: ['OK'],
                action: 'dismiss',
            };
        case 'downloaded':
            return {
                type: 'info',
                message: `${named(state.version)} is ready to install.`,
                detail: 'Restart now to finish updating, or later and it installs when you quit.',
                buttons: ['Restart Now', 'Later'],
                action: 'install',
            };
        case 'up-to-date':
            return {
                type: 'info',
                message: `${named(currentVersion)} is up to date.`,
                buttons: ['OK'],
                action: 'dismiss',
            };
        case 'unsupported':
            return {
                type: 'info',
                message: 'This build cannot check for updates.',
                detail: state.message,
                buttons: ['OK'],
                action: 'dismiss',
            };
        case 'error':
            return {
                type: 'error',
                message: 'Kubermeister could not check for updates.',
                detail: state.message,
                buttons: ['OK'],
                action: 'dismiss',
            };
        default:
            // `idle` and `checking` are not settled; a check that ends in one of them found no answer.
            return {
                type: 'error',
                message: 'Kubermeister could not check for updates.',
                detail: 'The check did not finish.',
                buttons: ['OK'],
                action: 'dismiss',
            };
    }
}

/** The prompt for a download that failed after the user asked for it. */
export function downloadFailedPrompt(state: UpdateState): UpdatePrompt {
    return {
        type: 'error',
        message: 'The update could not be downloaded.',
        detail: state.message,
        buttons: ['OK'],
        action: 'dismiss',
    };
}

/** Resolves with the first state that is a finished download, one way or the other. */
export function whenDownloadSettles(): Promise<UpdateState> {
    return new Promise((resolve) => {
        const current = getUpdateState();
        if (current.status === 'downloaded' || current.status === 'error') {
            resolve(current);
            return;
        }
        const stop = onUpdateState((next) => {
            if (next.status !== 'downloaded' && next.status !== 'error') return;
            stop();
            resolve(next);
        });
    });
}

/** Shows a prompt over the app's window and answers whether its leading button was chosen. */
async function ask(prompt: UpdatePrompt): Promise<boolean> {
    const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: MessageBoxOptions = {
        type: prompt.type,
        message: prompt.message,
        ...(prompt.detail ? { detail: prompt.detail } : {}),
        buttons: prompt.buttons,
        defaultId: 0,
        cancelId: prompt.buttons.length - 1,
        // Windows otherwise renders a two-button box as command links.
        noLink: true,
    };
    const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
    return prompt.action !== 'dismiss' && response === 0;
}

let running = false;

/**
 * Check, then tell the user what came of it and take the one action the answer allows: download a
 * found version, restart into a downloaded one. A download or a ready install already in progress
 * is reported as it stands rather than checked again. A second activation while a box is up is
 * ignored, since the box already asks the question.
 */
export async function runInteractiveCheck(): Promise<void> {
    if (running) return;
    running = true;
    try {
        const current = getUpdateState();
        const settled =
            current.status === 'downloaded' || current.status === 'downloading' ? current : await checkForUpdates();
        const prompt = promptFor(settled, app.getVersion());
        const chosen = await ask(prompt);
        if (prompt.action === 'install' && chosen) {
            installUpdate();
            return;
        }
        // In `download` mode the check itself started the download; the user still gets the restart
        // prompt when it lands, otherwise the box they just dismissed was the last they hear of it.
        const downloading =
            settled.status === 'downloading' || (prompt.action === 'download' && chosen && downloadUpdate());
        if (!downloading) return;
        const done = await whenDownloadSettles();
        if (done.status !== 'downloaded') {
            await ask(downloadFailedPrompt(done));
            return;
        }
        if (await ask(promptFor(done, app.getVersion()))) installUpdate();
    } finally {
        running = false;
    }
}
