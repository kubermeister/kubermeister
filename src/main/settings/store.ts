import { app } from 'electron';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    unwatchFile,
    watchFile,
    writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
    Settings,
    SettingsFileStatus,
    SettingsPatch,
    SettingsProblem,
    SettingsRead,
} from '../../shared/settings.js';
import { mergeSettings, migrateSettingsDocument, parseSettings, readSettings } from '../../shared/settings.js';
import type { SettingsDocument } from './document.js';
import {
    configForWrite,
    configFromLegacy,
    detectIndent,
    patchDocument,
    serializeDocument,
    stateFromLegacy,
} from './document.js';

/**
 * Owns the two files settings are kept in: a module-level cache plus plain get/update functions.
 *
 * The settings file is the user's: `~/.config/kubermeister/settings.json` on every OS, so it can be
 * written by hand, kept in a dotfiles repository and provisioned onto a machine. What the app
 * records about itself (the last context, remembered forwards, the window's bounds) is kept in
 * `state.json` in Electron's `userData`, beside its caches. Both are written eagerly and atomically,
 * a failure is logged but never thrown, so a settings problem cannot break the read paths that
 * depend on `getSettings`.
 */

interface LoadedFile {
    doc: SettingsDocument | undefined;
    indent: string;
    /** The file's text as last read or written, so a change on disk can be told from the app's own write. */
    text: string | null;
    exists: boolean;
    /** Why a file that exists could not be used at all: not readable, not JSON, not an object. */
    error: string | null;
}

const NO_FILE: LoadedFile = { doc: undefined, indent: '    ', text: null, exists: false, error: null };

let current: Settings | null = null;
let config: LoadedFile = NO_FILE;
let state: LoadedFile = NO_FILE;
let problems: SettingsProblem[] = [];
/**
 * Why the settings file is never written, or null when it may be. A file that is not JSON, or that
 * a newer version wrote, is somebody's configuration the app cannot fully read, and writing what it
 * did read back over it would replace that configuration with one nobody wrote.
 */
let blocked: string | null = null;
/** Why the last write failed, or null; cleared by the next one that succeeds. */
let writeFailure: string | null = null;

/**
 * Where the settings file lives. `KUBERMEISTER_CONFIG` names it outright. `KUBERMEISTER_USER_DATA`,
 * which tests use to keep every real file out of reach, keeps this one inside that directory too,
 * so no test can read the developer's own settings by forgetting a second variable. Otherwise it is
 * the XDG location, which is where a developer looks for it on macOS and Windows as well.
 */
export function settingsFilePath(): string {
    const explicit = process.env.KUBERMEISTER_CONFIG;
    if (explicit) return resolve(explicit);
    if (process.env.KUBERMEISTER_USER_DATA) return join(app.getPath('userData'), 'settings.json');
    const xdg = process.env.XDG_CONFIG_HOME;
    // The XDG specification says a relative value is invalid and is to be ignored.
    const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config');
    return join(base, 'kubermeister', 'settings.json');
}

function stateFilePath(): string {
    return join(app.getPath('userData'), 'state.json');
}

/** Where every install before the settings file moved kept everything, state included. */
function legacyFilePath(): string {
    return join(app.getPath('userData'), 'settings.json');
}

function isDocument(value: unknown): value is SettingsDocument {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A library's message as a sentence, so the one that follows it reads as a second sentence. */
function sentence(text: string): string {
    return /[.!?]$/.test(text) ? text : `${text}.`;
}

function readFile(path: string): LoadedFile {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch (error) {
        // A missing file is the first run, not a problem.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return NO_FILE;
        return { ...NO_FILE, exists: true, error: sentence(`It could not be read: ${errorMessage(error)}`) };
    }
    const found = { ...NO_FILE, exists: true, text, indent: detectIndent(text) };
    try {
        const parsed: unknown = JSON.parse(text);
        if (isDocument(parsed)) return { ...found, doc: parsed };
        return { ...found, error: 'It holds JSON, but not an object of settings.' };
    } catch (error) {
        return { ...found, error: sentence(`It is not valid JSON: ${errorMessage(error)}`) };
    }
}

/**
 * Write through a symlink rather than over it: a file linked in by stow, chezmoi or home-manager
 * stays linked, and the temporary file sits next to the real one so the rename stays on one volume.
 */
function writeFile(path: string, text: string): string | null {
    try {
        const target = existsSync(path) ? realpathSync(path) : path;
        mkdirSync(dirname(target), { recursive: true });
        const tmp = `${target}.tmp`;
        writeFileSync(tmp, text, 'utf8');
        renameSync(tmp, target);
        return null;
    } catch (error) {
        console.error(`[settings] failed to write ${path}`, error);
        return errorMessage(error);
    }
}

/**
 * The first launch after the settings file moved: the old whole-object file becomes a settings file
 * holding what somebody changed and a state file holding the rest. Each is carried over only while
 * it does not exist yet, and apart: a settings file written by hand before the first launch wins
 * over the old preferences, but the last context, the remembered forwards and the window's place
 * still come across. The old file is left where it was, so going back to an earlier version finds
 * it.
 */
function migrateLegacy(configPath: string): void {
    const legacyPath = legacyFilePath();
    const needsConfig = resolve(legacyPath) !== resolve(configPath) && !existsSync(configPath);
    const needsState = !existsSync(stateFilePath());
    if ((!needsConfig && !needsState) || !existsSync(legacyPath)) return;
    const legacy = readFile(legacyPath);
    if (!legacy.doc) return;
    const settings = parseSettings(legacy.doc);
    if (needsConfig) writeFile(configPath, serializeDocument(configFromLegacy(settings), legacy.indent));
    if (needsState) writeFile(stateFilePath(), serializeDocument(stateFromLegacy(settings), legacy.indent));
}

/** Take in the settings file as read, over the state already held. */
function takeConfig(loaded: LoadedFile): SettingsRead {
    // Kept migrated, so the first save also brings an older file up to the current version.
    config = { ...loaded, doc: loaded.doc && migrateSettingsDocument(loaded.doc) };
    const read = readSettings(config.doc, state.doc);
    problems = read.problems;
    blocked = config.error
        ? `${config.error} Kubermeister is running on its defaults and will not write the file until it is fixed.`
        : read.newer
          ? 'A newer version of Kubermeister wrote this file, so this one will not write it.'
          : null;
    writeFailure = null;
    return read;
}

function loadSettings(): Settings {
    const configPath = settingsFilePath();
    migrateLegacy(configPath);
    state = readFile(stateFilePath());
    return takeConfig(readFile(configPath)).settings;
}

export function getSettings(): Settings {
    if (!current) current = loadSettings();
    return current;
}

/** Apply a patch, writing each file only when a key it holds actually changed. */
export function updateSettings(patch: SettingsPatch): Settings {
    current = mergeSettings(getSettings(), patch);
    const nextConfig = blocked ? null : patchDocument(config.doc ?? {}, patch, 'config');
    if (nextConfig) {
        const written = configForWrite(nextConfig);
        const text = serializeDocument(written, config.indent);
        config = { ...config, doc: written, text, exists: true };
        const failure = writeFile(settingsFilePath(), text);
        writeFailure = failure && `The file could not be saved (${failure}). Changes made here last until you quit.`;
    }
    const nextState = patchDocument(state.doc ?? {}, patch, 'state');
    if (nextState) {
        state = { ...state, doc: nextState };
        writeFile(stateFilePath(), serializeDocument(nextState, state.indent));
    }
    return current;
}

/** Where the settings file is and what is wrong with it; reading it loads the settings first. */
export function settingsFileStatus(): SettingsFileStatus {
    getSettings();
    return {
        path: settingsFilePath(),
        exists: config.exists,
        readOnly: blocked ?? writeFailure,
        blocked: blocked !== null,
        problems,
    };
}

export interface SettingsChange {
    before: Settings;
    after: Settings;
}

/**
 * Read the settings file again after it changed on disk. Null when it reads exactly as the app last
 * read or wrote it, which is what the app's own saves look like from here. A change made in the app
 * that the file never took, because it could not be written, gives way to what the file says.
 */
export function reloadSettingsFile(): SettingsChange | null {
    const before = getSettings();
    const loaded = readFile(settingsFilePath());
    if (loaded.text === config.text && loaded.error === config.error) return null;
    current = takeConfig(loaded).settings;
    return { before, after: current };
}

/** How often the file is looked at: an edit takes effect within a second of being saved. */
const WATCH_INTERVAL_MS = 1_000;

/**
 * Follow the settings file for edits made outside the app. The file is polled rather than watched
 * through the OS: an editor that saves by renaming a new file into place, a symlink whose target
 * changes, and a file that does not exist yet are all a stat away, where an OS watch loses track
 * of the first two and cannot be set on the third. The poll keeps no process alive.
 */
export function watchSettingsFile(onChange: (change: SettingsChange) => void): () => void {
    const path = settingsFilePath();
    const listener = () => {
        const change = reloadSettingsFile();
        if (change) onChange(change);
    };
    watchFile(path, { interval: WATCH_INTERVAL_MS, persistent: false }, listener);
    return () => unwatchFile(path, listener);
}
