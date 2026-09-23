import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Settings, SettingsFileStatus, SettingsPatch, SettingsProblem } from '../../shared/settings.js';
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
    exists: boolean;
    /** Why a file that exists could not be used at all: not readable, not JSON, not an object. */
    error: string | null;
}

const NO_FILE: LoadedFile = { doc: undefined, indent: '    ', exists: false, error: null };

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

function readFile(path: string): LoadedFile {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch (error) {
        // A missing file is the first run, not a problem.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return NO_FILE;
        return { ...NO_FILE, exists: true, error: `It could not be read: ${errorMessage(error)}` };
    }
    const found = { ...NO_FILE, exists: true, indent: detectIndent(text) };
    try {
        const parsed: unknown = JSON.parse(text);
        if (isDocument(parsed)) return { ...found, doc: parsed };
        return { ...found, error: 'It holds JSON, but not an object of settings.' };
    } catch (error) {
        return { ...found, error: `It is not valid JSON: ${errorMessage(error)}` };
    }
}

/**
 * Write through a symlink rather than over it: a file linked in by stow, chezmoi or home-manager
 * stays linked, and the temporary file sits next to the real one so the rename stays on one volume.
 */
function writeFile(path: string, doc: SettingsDocument, indent: string): string | null {
    try {
        const target = existsSync(path) ? realpathSync(path) : path;
        mkdirSync(dirname(target), { recursive: true });
        const tmp = `${target}.tmp`;
        writeFileSync(tmp, serializeDocument(doc, indent), 'utf8');
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
    if (needsConfig) writeFile(configPath, configFromLegacy(settings), legacy.indent);
    if (needsState) writeFile(stateFilePath(), stateFromLegacy(settings), legacy.indent);
}

function loadSettings(): Settings {
    const configPath = settingsFilePath();
    migrateLegacy(configPath);
    const loaded = readFile(configPath);
    // Kept migrated, so the first save also brings an older file up to the current version.
    config = { ...loaded, doc: loaded.doc && migrateSettingsDocument(loaded.doc) };
    state = readFile(stateFilePath());
    const read = readSettings(config.doc, state.doc);
    problems = read.problems;
    blocked = config.error
        ? `${config.error} Kubermeister is running on its defaults and will not write the file until it is fixed.`
        : read.newer
          ? 'A newer version of Kubermeister wrote this file, so this one will not write it.'
          : null;
    writeFailure = null;
    return read.settings;
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
        config = { ...config, doc: written, exists: true };
        const failure = writeFile(settingsFilePath(), written, config.indent);
        writeFailure = failure && `The file could not be saved (${failure}). Changes made here last until you quit.`;
    }
    const nextState = patchDocument(state.doc ?? {}, patch, 'state');
    if (nextState) {
        state = { ...state, doc: nextState };
        writeFile(stateFilePath(), nextState, state.indent);
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
