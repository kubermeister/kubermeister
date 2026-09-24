import { isDeepStrictEqual } from 'node:util';
import type { Settings, SettingsPatch } from '../../shared/settings.js';
import { DEFAULT_SETTINGS, isStateKey, SETTINGS_SECTIONS, SETTINGS_VERSION } from '../../shared/settings.js';

/**
 * A settings or state file as JSON, kept as the file had it rather than as the app would write it,
 * so that a save changes the keys it sets and nothing else. A hand-written file stays the size its
 * author wrote it: keys never mentioned stay absent and follow the defaults, keys this version does
 * not know survive for the version that does.
 */
export type SettingsDocument = Record<string, unknown>;

/** Which of the two files a key belongs in; see `STATE_KEYS`. */
export type SettingsFile = 'config' | 'state';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function belongsIn(file: SettingsFile, section: string, key: string): boolean {
    return isStateKey(section, key) === (file === 'state');
}

/**
 * Set every key the patch names that belongs in `file`, keeping the order the file already has and
 * appending what is new. Answers null when the file would read the same afterwards, so a save that
 * changes nothing writes nothing.
 */
export function patchDocument(
    doc: SettingsDocument,
    patch: SettingsPatch,
    file: SettingsFile,
): SettingsDocument | null {
    const next: SettingsDocument = { ...doc };
    let changed = false;
    for (const [section, values] of Object.entries(patch)) {
        if (!isRecord(values)) continue;
        const current = isRecord(next[section]) ? next[section] : {};
        const updated: Record<string, unknown> = { ...current };
        let sectionChanged = false;
        for (const [key, value] of Object.entries(values)) {
            if (value === undefined || !belongsIn(file, section, key)) continue;
            if (key in current && isDeepStrictEqual(current[key], value)) continue;
            updated[key] = value;
            sectionChanged = true;
        }
        if (!sectionChanged) continue;
        next[section] = updated;
        changed = true;
    }
    return changed ? next : null;
}

/**
 * The settings file as it is written: at the current version, and without the keys the state file
 * now holds, which a file from before that split still carries. A section left empty goes too.
 */
export function configForWrite(doc: SettingsDocument): SettingsDocument {
    const out: SettingsDocument = {};
    if (typeof doc.$schema === 'string') out.$schema = doc.$schema;
    out.version = SETTINGS_VERSION;
    for (const [section, values] of Object.entries(doc)) {
        if (section === '$schema' || section === 'version') continue;
        if (!isRecord(values)) {
            out[section] = values;
            continue;
        }
        const kept = Object.fromEntries(Object.entries(values).filter(([key]) => !isStateKey(section, key)));
        if (Object.keys(kept).length > 0) out[section] = kept;
    }
    return out;
}

function pick(settings: Settings, file: SettingsFile, onlyChosen: boolean): SettingsDocument {
    const doc: SettingsDocument = {};
    for (const section of SETTINGS_SECTIONS) {
        const values: Record<string, unknown> = settings[section];
        const defaults: Record<string, unknown> = DEFAULT_SETTINGS[section];
        const kept = Object.entries(values).filter(
            ([key, value]) => belongsIn(file, section, key) && !(onlyChosen && isDeepStrictEqual(value, defaults[key])),
        );
        if (kept.length > 0) doc[section] = Object.fromEntries(kept);
    }
    return doc;
}

/**
 * The settings file a whole-object file from before becomes. That file was rewritten in full on
 * every save, so a value equal to its default is no evidence anybody chose it and is left out,
 * leaving only what somebody actually changed.
 */
export function configFromLegacy(settings: Settings): SettingsDocument {
    return { version: SETTINGS_VERSION, ...pick(settings, 'config', true) };
}

export function stateFromLegacy(settings: Settings): SettingsDocument {
    return pick(settings, 'state', false);
}

/** The indentation a file already uses, so a save does not reformat somebody's file; four spaces otherwise. */
export function detectIndent(text: string): string {
    return /^[ \t]*\{\s*?\n([ \t]+)\S/.exec(text)?.[1] ?? '    ';
}

export function serializeDocument(doc: SettingsDocument, indent: string): string {
    return `${JSON.stringify(doc, null, indent)}\n`;
}
