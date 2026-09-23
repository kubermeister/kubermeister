import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Settings, SettingsPatch } from '../../shared/settings.js';
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
}

let current: Settings | null = null;
let config: LoadedFile = { doc: undefined, indent: '    ' };
let state: LoadedFile = { doc: undefined, indent: '    ' };

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

function readFile(path: string): LoadedFile {
    try {
        const text = readFileSync(path, 'utf8');
        const parsed: unknown = JSON.parse(text);
        return { doc: isDocument(parsed) ? parsed : undefined, indent: detectIndent(text) };
    } catch {
        // Missing file (first run), unreadable, or not JSON: it contributes nothing.
        return { doc: undefined, indent: '    ' };
    }
}

/**
 * Write through a symlink rather than over it: a file linked in by stow, chezmoi or home-manager
 * stays linked, and the temporary file sits next to the real one so the rename stays on one volume.
 */
function writeFile(path: string, doc: SettingsDocument, indent: string): void {
    try {
        const target = existsSync(path) ? realpathSync(path) : path;
        mkdirSync(dirname(target), { recursive: true });
        const tmp = `${target}.tmp`;
        writeFileSync(tmp, serializeDocument(doc, indent), 'utf8');
        renameSync(tmp, target);
    } catch (error) {
        console.error(`[settings] failed to write ${path}`, error);
    }
}

/**
 * The first launch after the settings file moved: the old whole-object file becomes a settings file
 * holding what somebody changed and a state file holding the rest. The old file is left where it
 * was, so going back to an earlier version finds it.
 */
function migrateLegacy(configPath: string): void {
    const legacyPath = legacyFilePath();
    if (resolve(legacyPath) === resolve(configPath) || existsSync(configPath) || !existsSync(legacyPath)) return;
    const legacy = readFile(legacyPath);
    if (!legacy.doc) return;
    const settings = parseSettings(legacy.doc);
    writeFile(configPath, configFromLegacy(settings), legacy.indent);
    if (!existsSync(stateFilePath())) writeFile(stateFilePath(), stateFromLegacy(settings), legacy.indent);
}

function loadSettings(): Settings {
    const configPath = settingsFilePath();
    migrateLegacy(configPath);
    const loaded = readFile(configPath);
    // Kept migrated, so the first save also brings an older file up to the current version.
    config = { ...loaded, doc: loaded.doc && migrateSettingsDocument(loaded.doc) };
    state = readFile(stateFilePath());
    return readSettings(config.doc, state.doc).settings;
}

export function getSettings(): Settings {
    if (!current) current = loadSettings();
    return current;
}

/** Apply a patch, writing each file only when a key it holds actually changed. */
export function updateSettings(patch: SettingsPatch): Settings {
    current = mergeSettings(getSettings(), patch);
    const nextConfig = patchDocument(config.doc ?? {}, patch, 'config');
    if (nextConfig) {
        const written = configForWrite(nextConfig);
        config = { ...config, doc: written };
        writeFile(settingsFilePath(), written, config.indent);
    }
    const nextState = patchDocument(state.doc ?? {}, patch, 'state');
    if (nextState) {
        state = { ...state, doc: nextState };
        writeFile(stateFilePath(), nextState, state.indent);
    }
    return current;
}
