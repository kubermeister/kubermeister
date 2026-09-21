import { app, BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import type { UpdateState } from '../shared/ipc.js';
import { releasePageUrl } from '../shared/updates.js';
import { checkForUpdates, downloadUpdate, getUpdateState, installUpdate, onUpdateState } from './updater.js';
import { openExternally } from './window.js';

/**
 * The native update flow behind the menu's "Check for Updates…". The top-bar pill and the Settings
 * card only exist once the renderer has mounted past the startup checks; a kubeconfig that will not
 * load, a white screen or a crashed renderer leaves them unreachable, and an update found in that
 * state has nowhere to show. This flow needs no renderer: the outcome of the check, the download
 * and the restart are all message boxes owned by main, so the way out of a broken install is never
 * itself behind the thing that broke.
 */

/** What a button of a prompt does. `notes` opens the release page and leaves the question open. */
export type PromptAction = 'download' | 'install' | 'notes' | 'dismiss';

export interface UpdatePrompt {
    type: 'info' | 'error';
    message: string;
    detail?: string;
    /** The leading button first; the last button is what Escape and closing the box mean. */
    buttons: string[];
    /** What each button does, by index, so a box and the meaning of its answer cannot drift apart. */
    actions: PromptAction[];
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
        case 'available': {
            // The changelog itself lives on the release page: generated notes are a list of pull
            // requests, too long for a message box and already rendered properly over there. The
            // page is named by the version, so a state that lost it is offered no way through.
            const linkable = state.version !== undefined;
            return {
                type: 'info',
                message: `${named(state.version)} is available.`,
                detail: paragraphs(`You have ${currentVersion}.`, releasedOn(state.releaseDate)),
                buttons: linkable ? ['Download', 'Release Notes', 'Later'] : ['Download', 'Later'],
                actions: linkable ? ['download', 'notes', 'dismiss'] : ['download', 'dismiss'],
            };
        }
        case 'manual': {
            // No Download button on purpose: this package is the system's to replace, so the box
            // offers what the app can honestly do — name the version and open its page.
            const linkable = state.version !== undefined;
            return {
                type: 'info',
                message: `${named(state.version)} is available.`,
                detail: paragraphs(`You have ${currentVersion}.`, state.message ?? ''),
                buttons: linkable ? ['Release Notes', 'OK'] : ['OK'],
                actions: linkable ? ['notes', 'dismiss'] : ['dismiss'],
            };
        }
        case 'downloading':
            return {
                type: 'info',
                message: `${named(state.version)} is downloading.`,
                detail: 'You will be asked to restart once it is ready.',
                buttons: ['OK'],
                actions: ['dismiss'],
            };
        case 'downloaded':
            return {
                type: 'info',
                message: `${named(state.version)} is ready to install.`,
                detail: 'Restart now to finish updating, or later and it installs when you quit.',
                buttons: ['Restart Now', 'Later'],
                actions: ['install', 'dismiss'],
            };
        case 'up-to-date':
            return {
                type: 'info',
                message: `${named(currentVersion)} is up to date.`,
                buttons: ['OK'],
                actions: ['dismiss'],
            };
        case 'unsupported':
            return {
                type: 'info',
                message: 'This build cannot check for updates.',
                detail: state.message,
                buttons: ['OK'],
                actions: ['dismiss'],
            };
        case 'error':
            return {
                type: 'error',
                message: 'Kubermeister could not check for updates.',
                detail: state.message,
                buttons: ['OK'],
                actions: ['dismiss'],
            };
        default:
            // `idle` and `checking` are not settled; a check that ends in one of them found no answer.
            return {
                type: 'error',
                message: 'Kubermeister could not check for updates.',
                detail: 'The check did not finish.',
                buttons: ['OK'],
                actions: ['dismiss'],
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
        actions: ['dismiss'],
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

/** Shows a prompt over the app's window and answers what the button the user chose means. */
async function ask(prompt: UpdatePrompt): Promise<PromptAction> {
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
    return prompt.actions[response] ?? 'dismiss';
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
        let chosen = await ask(prompt);
        // Reading the notes is not an answer to what the box asked, so it asks again afterwards.
        while (chosen === 'notes' && settled.version) {
            openExternally(releasePageUrl(settled.version));
            chosen = await ask(prompt);
        }
        if (chosen === 'install') {
            installUpdate();
            return;
        }
        // In `download` mode the check itself started the download; the user still gets the restart
        // prompt when it lands, otherwise the box they just dismissed was the last they hear of it.
        const downloading = settled.status === 'downloading' || (chosen === 'download' && downloadUpdate());
        if (!downloading) return;
        const done = await whenDownloadSettles();
        if (done.status !== 'downloaded') {
            await ask(downloadFailedPrompt(done));
            return;
        }
        if ((await ask(promptFor(done, app.getVersion()))) === 'install') installUpdate();
    } finally {
        running = false;
    }
}
