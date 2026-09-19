import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings, SettingsPatch } from '../../shared/settings.js';
import { mergeSettings, parseSettings } from '../../shared/settings.js';

/**
 * Owns the persisted settings file: a module-level cache plus plain get/update functions. Every
 * update is written eagerly with an atomic write-temp-then-rename, and a write failure is logged
 * but never thrown, so a settings problem cannot break the read paths that depend on `getSettings`.
 *
 * The file lives in Electron's `userData`, which is per product name. `src/main/index.ts` lets
 * `KUBERMEISTER_USER_DATA` redirect that directory, which is how tests keep the real settings out
 * of reach.
 */

let current: Settings | null = null;

function settingsPath(): string {
    return join(app.getPath('userData'), 'settings.json');
}

function loadSettings(): Settings {
    try {
        return parseSettings(JSON.parse(readFileSync(settingsPath(), 'utf8')));
    } catch {
        // Missing file (first run), unreadable, or not JSON: start from defaults.
        return parseSettings(undefined);
    }
}

function persist(settings: Settings): void {
    try {
        const dir = app.getPath('userData');
        mkdirSync(dir, { recursive: true });
        const tmp = join(dir, 'settings.json.tmp');
        writeFileSync(tmp, JSON.stringify(settings, null, 4), 'utf8');
        renameSync(tmp, settingsPath());
    } catch (error) {
        console.error('[settings] failed to persist settings', error);
    }
}

export function getSettings(): Settings {
    if (!current) current = loadSettings();
    return current;
}

export function updateSettings(patch: SettingsPatch): Settings {
    current = mergeSettings(getSettings(), patch);
    persist(current);
    return current;
}
