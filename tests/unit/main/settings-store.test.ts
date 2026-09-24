import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '../../../src/shared/settings';

let root = '';
let userData = '';
let configFile = '';
vi.mock('electron', () => ({ app: { getPath: () => userData } }));

async function loadStore() {
    vi.resetModules();
    return import('../../../src/main/settings/store.js');
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

describe('settings store', () => {
    // Restored key by key: replacing `process.env` with a plain object would leave libuv, which
    // `homedir()` asks, reading the real environment from then on.
    const keys = ['KUBERMEISTER_CONFIG', 'KUBERMEISTER_USER_DATA', 'XDG_CONFIG_HOME', 'HOME', 'USERPROFILE'];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'km-settings-'));
        userData = join(root, 'user-data');
        mkdirSync(userData);
        configFile = join(root, 'config', 'kubermeister', 'settings.json');
        process.env.KUBERMEISTER_CONFIG = configFile;
    });

    afterEach(() => {
        for (const key of keys) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
        rmSync(root, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    describe('where the settings file is', () => {
        beforeEach(() => {
            delete process.env.KUBERMEISTER_CONFIG;
            delete process.env.KUBERMEISTER_USER_DATA;
            delete process.env.XDG_CONFIG_HOME;
            process.env.HOME = root;
            process.env.USERPROFILE = root;
        });

        it('is ~/.config/kubermeister/settings.json on every OS', async () => {
            const { settingsFilePath } = await loadStore();
            expect(settingsFilePath()).toBe(join(root, '.config', 'kubermeister', 'settings.json'));
        });

        it('follows an absolute XDG_CONFIG_HOME and ignores a relative one', async () => {
            process.env.XDG_CONFIG_HOME = join(root, 'xdg');
            const { settingsFilePath } = await loadStore();
            expect(settingsFilePath()).toBe(join(root, 'xdg', 'kubermeister', 'settings.json'));
            process.env.XDG_CONFIG_HOME = 'relative/config';
            expect(settingsFilePath()).toBe(join(root, '.config', 'kubermeister', 'settings.json'));
        });

        it('is the file KUBERMEISTER_CONFIG names', async () => {
            process.env.KUBERMEISTER_CONFIG = join(root, 'ci', 'settings.json');
            const { settingsFilePath } = await loadStore();
            expect(settingsFilePath()).toBe(join(root, 'ci', 'settings.json'));
        });

        it('stays inside a redirected user-data directory, so an isolated run never reads the real one', async () => {
            process.env.KUBERMEISTER_USER_DATA = userData;
            const { settingsFilePath } = await loadStore();
            expect(settingsFilePath()).toBe(join(userData, 'settings.json'));
        });
    });

    it('starts from defaults when no file exists and creates none on read', async () => {
        const { getSettings } = await loadStore();
        expect(getSettings()).toEqual(DEFAULT_SETTINGS);
        expect(existsSync(configFile)).toBe(false);
        expect(existsSync(join(userData, 'state.json'))).toBe(false);
    });

    it('reads a hand-written file of a few keys, with no version, over the defaults', async () => {
        mkdirSync(join(root, 'config', 'kubermeister'), { recursive: true });
        writeFileSync(configFile, JSON.stringify({ data: { refreshIntervalSec: 5 }, general: { confirmQuit: false } }));
        const { getSettings } = await loadStore();
        expect(getSettings()).toEqual({
            ...DEFAULT_SETTINGS,
            general: { confirmQuit: false },
            data: { ...DEFAULT_SETTINGS.data, refreshIntervalSec: 5 },
        });
    });

    it('caches what it read', async () => {
        mkdirSync(join(root, 'config', 'kubermeister'), { recursive: true });
        writeFileSync(configFile, JSON.stringify({ data: { refreshIntervalSec: 5 } }));
        const { getSettings } = await loadStore();
        expect(getSettings().data.refreshIntervalSec).toBe(5);
        writeFileSync(configFile, JSON.stringify({}));
        expect(getSettings().data.refreshIntervalSec).toBe(5);
    });

    it('falls back to defaults on a file that is not JSON', async () => {
        mkdirSync(join(root, 'config', 'kubermeister'), { recursive: true });
        writeFileSync(configFile, '{ not json');
        const { getSettings } = await loadStore();
        expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    });

    it('writes only the key a save sets, keeping unknown keys, their order and the file’s indentation', async () => {
        mkdirSync(join(root, 'config', 'kubermeister'), { recursive: true });
        const written = { future: { flag: true }, data: { refreshIntervalSec: 5 } };
        writeFileSync(configFile, JSON.stringify(written, null, 2));
        const { updateSettings } = await loadStore();
        const next = updateSettings({ data: { readTimeoutSec: 120 } });
        expect(next.data).toMatchObject({ refreshIntervalSec: 5, readTimeoutSec: 120 });
        const text = readFileSync(configFile, 'utf8');
        expect(JSON.parse(text)).toEqual({
            version: 2,
            future: { flag: true },
            data: { refreshIntervalSec: 5, readTimeoutSec: 120 },
        });
        expect(Object.keys(JSON.parse(text) as object)).toEqual(['version', 'future', 'data']);
        expect(text).toContain('\n  "future"');
        expect(text.endsWith('}\n')).toBe(true);
        expect(existsSync(`${configFile}.tmp`)).toBe(false);
    });

    it('creates the settings file on the first save, holding only what was saved', async () => {
        const { updateSettings } = await loadStore();
        updateSettings({ general: { confirmQuit: false } });
        expect(readJson(configFile)).toEqual({ version: 2, general: { confirmQuit: false } });
    });

    it('writes nothing when a save changes nothing', async () => {
        mkdirSync(join(root, 'config', 'kubermeister'), { recursive: true });
        writeFileSync(configFile, JSON.stringify({ data: { refreshIntervalSec: 5 } }));
        const { updateSettings } = await loadStore();
        updateSettings({ data: { refreshIntervalSec: 5 } });
        expect(readJson(configFile)).toEqual({ data: { refreshIntervalSec: 5 } });
    });

    it('keeps what the app records about itself in state.json, out of the settings file', async () => {
        const { getSettings, updateSettings } = await loadStore();
        updateSettings({
            session: { lastContext: 'prod', lastNamespace: 'web' },
            window: { bounds: { x: 1, y: 2, width: 800, height: 600 } },
        });
        expect(existsSync(configFile)).toBe(false);
        expect(readJson(join(userData, 'state.json'))).toEqual({
            session: { lastContext: 'prod', lastNamespace: 'web' },
            window: { bounds: { x: 1, y: 2, width: 800, height: 600 } },
        });
        const store = await loadStore();
        expect(store.getSettings().session).toMatchObject({ lastContext: 'prod', lastNamespace: 'web' });
        expect(getSettings().window.bounds).toEqual({ x: 1, y: 2, width: 800, height: 600 });
    });

    it('reads state still kept in the settings file and drops it from there on the next save', async () => {
        mkdirSync(join(root, 'config', 'kubermeister'), { recursive: true });
        writeFileSync(
            configFile,
            JSON.stringify({
                version: 1,
                session: { lastContext: 'k3s', restoreOnLaunch: false },
                updates: { mode: 'check' },
            }),
        );
        const { getSettings, updateSettings } = await loadStore();
        expect(getSettings().session).toEqual({ lastContext: 'k3s', lastNamespace: null, restoreOnLaunch: false });
        updateSettings({ data: { terminalFontSize: 14 } });
        // Brought to the current version on the way: the `check` a version 1 file carries was nobody's choice.
        expect(readJson(configFile)).toEqual({
            version: 2,
            session: { restoreOnLaunch: false },
            data: { terminalFontSize: 14 },
        });
    });

    it('moves an old whole-object file over once, keeping only what somebody changed', async () => {
        const legacy = {
            ...DEFAULT_SETTINGS,
            session: { lastContext: 'prod', lastNamespace: 'web', restoreOnLaunch: true },
            data: { ...DEFAULT_SETTINGS.data, readTimeoutSec: 300 },
            window: { bounds: { x: 0, y: 0, width: 1000, height: 700 } },
        };
        writeFileSync(join(userData, 'settings.json'), JSON.stringify(legacy, null, 4));
        const { getSettings } = await loadStore();
        expect(getSettings()).toEqual(legacy);
        expect(readJson(configFile)).toEqual({ version: 2, data: { readTimeoutSec: 300 } });
        expect(readJson(join(userData, 'state.json'))).toEqual({
            session: { lastContext: 'prod', lastNamespace: 'web' },
            data: { forwards: [] },
            window: { bounds: { x: 0, y: 0, width: 1000, height: 700 } },
        });
        expect(existsSync(join(userData, 'settings.json'))).toBe(true);

        // Once the new file exists the old one is never read again.
        writeFileSync(join(userData, 'settings.json'), JSON.stringify({ ...legacy, data: DEFAULT_SETTINGS.data }));
        const again = await loadStore();
        expect(again.getSettings().data.readTimeoutSec).toBe(300);
    });

    it('carries the old state over even when a settings file was written by hand before the first launch', async () => {
        const legacy = mergeSettings(DEFAULT_SETTINGS, {
            session: { lastContext: 'prod' },
            data: { readTimeoutSec: 300 },
        });
        writeFileSync(join(userData, 'settings.json'), JSON.stringify(legacy));
        mkdirSync(join(root, 'config', 'kubermeister'), { recursive: true });
        writeFileSync(configFile, JSON.stringify({ data: { refreshIntervalSec: 5 } }));
        const { getSettings } = await loadStore();
        // The hand-written file is the configuration; the old one's preferences do not override it.
        expect(getSettings().data).toMatchObject({ refreshIntervalSec: 5, readTimeoutSec: 60 });
        expect(readJson(configFile)).toEqual({ data: { refreshIntervalSec: 5 } });
        expect(getSettings().session.lastContext).toBe('prod');
    });

    it('writes through a symlinked settings file rather than replacing the link', async () => {
        const real = join(root, 'dotfiles', 'settings.json');
        mkdirSync(join(root, 'dotfiles'));
        mkdirSync(join(root, 'config', 'kubermeister'), { recursive: true });
        writeFileSync(real, JSON.stringify({ data: { refreshIntervalSec: 5 } }));
        symlinkSync(real, configFile);
        const { updateSettings } = await loadStore();
        updateSettings({ general: { confirmQuit: false } });
        expect(lstatSync(configFile).isSymbolicLink()).toBe(true);
        expect(readJson(real)).toEqual({
            version: 2,
            data: { refreshIntervalSec: 5 },
            general: { confirmQuit: false },
        });
    });

    describe('a file it cannot fully read', () => {
        beforeEach(() => {
            mkdirSync(join(root, 'config', 'kubermeister'), { recursive: true });
        });

        it('never writes a file that is not JSON, and says why', async () => {
            writeFileSync(configFile, '{ "data": { "refreshIntervalSec": 5, } }');
            const { getSettings, settingsFileStatus, updateSettings } = await loadStore();
            expect(getSettings()).toEqual(DEFAULT_SETTINGS);
            const next = updateSettings({ general: { confirmQuit: false } });
            // The change still holds for this run; only the file is left alone.
            expect(next.general.confirmQuit).toBe(false);
            expect(readFileSync(configFile, 'utf8')).toBe('{ "data": { "refreshIntervalSec": 5, } }');
            expect(settingsFileStatus()).toMatchObject({
                path: configFile,
                exists: true,
                blocked: true,
                readOnly: expect.stringMatching(
                    /^It is not valid JSON: .*[.!?] Kubermeister is running on its defaults and will not write the file until it is fixed\.$/,
                ),
            });
        });

        it('never writes a file that holds JSON other than an object', async () => {
            writeFileSync(configFile, '[1, 2]');
            const { settingsFileStatus, updateSettings } = await loadStore();
            updateSettings({ general: { confirmQuit: false } });
            expect(readFileSync(configFile, 'utf8')).toBe('[1, 2]');
            expect(settingsFileStatus().readOnly).toMatch(/^It holds JSON, but not an object of settings\./);
        });

        it('never writes a file a newer version wrote, while using what of it still validates', async () => {
            const newer = JSON.stringify({ version: 3, data: { refreshIntervalSec: 5 } });
            writeFileSync(configFile, newer);
            const { getSettings, settingsFileStatus, updateSettings } = await loadStore();
            expect(getSettings().data.refreshIntervalSec).toBe(5);
            updateSettings({ general: { confirmQuit: false } });
            expect(readFileSync(configFile, 'utf8')).toBe(newer);
            expect(settingsFileStatus()).toMatchObject({ blocked: true, readOnly: expect.stringContaining('newer') });
        });

        it('still records the app’s own state while the settings file is blocked', async () => {
            writeFileSync(configFile, 'nope');
            const { updateSettings } = await loadStore();
            updateSettings({ session: { lastContext: 'prod' } });
            expect(readJson(join(userData, 'state.json'))).toEqual({ session: { lastContext: 'prod' } });
        });

        it('names every refused value and unknown key, and still writes the file', async () => {
            writeFileSync(configFile, JSON.stringify({ data: { readTimeoutSec: 1, refreshSec: 5 } }));
            const { settingsFileStatus, updateSettings } = await loadStore();
            expect(settingsFileStatus()).toEqual({
                path: configFile,
                exists: true,
                readOnly: null,
                blocked: false,
                problems: [
                    { path: 'data.readTimeoutSec', message: expect.any(String) },
                    { path: 'data.refreshSec', message: 'Unknown setting, ignored.' },
                ],
            });
            updateSettings({ general: { confirmQuit: false } });
            // The refused value stays in the file for its author to fix; the app does not overwrite it.
            expect(readJson(configFile)).toEqual({
                version: 2,
                data: { readTimeoutSec: 1, refreshSec: 5 },
                general: { confirmQuit: false },
            });
        });
    });

    it('never writes where the file cannot even be read', async () => {
        // A file where the directory should be: reading fails with something other than "missing".
        writeFileSync(join(root, 'config'), 'not a directory');
        const { settingsFileStatus, updateSettings } = await loadStore();
        updateSettings({ general: { confirmQuit: false } });
        expect(settingsFileStatus()).toMatchObject({
            exists: true,
            blocked: true,
            readOnly: /^It could not be read: /,
        });
    });

    it('reports no file while there is none', async () => {
        const { settingsFileStatus } = await loadStore();
        expect(settingsFileStatus()).toEqual({
            path: configFile,
            exists: false,
            readOnly: null,
            blocked: false,
            problems: [],
        });
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
        'reports a file it could not save, and clears that once a save lands',
        async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {});
            const dir = join(root, 'config', 'kubermeister');
            mkdirSync(dir, { recursive: true });
            writeFileSync(configFile, '{}');
            chmodSync(dir, 0o555);
            const { settingsFileStatus, updateSettings } = await loadStore();
            updateSettings({ general: { confirmQuit: false } });
            expect(settingsFileStatus()).toMatchObject({
                blocked: false,
                readOnly: expect.stringMatching(
                    /^The file could not be saved \(.+\)\. Changes made here last until you quit\.$/,
                ),
            });
            chmodSync(dir, 0o755);
            updateSettings({ general: { confirmQuit: true } });
            expect(settingsFileStatus().readOnly).toBe(null);
        },
    );

    describe('an edit made outside the app', () => {
        beforeEach(() => {
            mkdirSync(join(root, 'config', 'kubermeister'), { recursive: true });
        });

        it('is taken in, with what the settings were before it', async () => {
            writeFileSync(configFile, JSON.stringify({ data: { refreshIntervalSec: 5 } }));
            const { getSettings, reloadSettingsFile } = await loadStore();
            expect(getSettings().data.refreshIntervalSec).toBe(5);
            writeFileSync(configFile, JSON.stringify({ data: { refreshIntervalSec: 30 } }));
            const change = reloadSettingsFile();
            expect(change?.before.data.refreshIntervalSec).toBe(5);
            expect(change?.after.data.refreshIntervalSec).toBe(30);
            expect(getSettings().data.refreshIntervalSec).toBe(30);
        });

        it('is nothing when the file reads as the app last wrote it', async () => {
            const { reloadSettingsFile, updateSettings } = await loadStore();
            updateSettings({ general: { confirmQuit: false } });
            expect(reloadSettingsFile()).toBe(null);
        });

        it('keeps the app’s own state, which the settings file does not hold', async () => {
            const { getSettings, reloadSettingsFile, updateSettings } = await loadStore();
            updateSettings({ session: { lastContext: 'prod' } });
            writeFileSync(configFile, JSON.stringify({ general: { confirmQuit: false } }));
            reloadSettingsFile();
            expect(getSettings().session.lastContext).toBe('prod');
            expect(getSettings().general.confirmQuit).toBe(false);
        });

        it('stops the app writing a file broken on disk, and lets it again once the file is fixed', async () => {
            writeFileSync(configFile, JSON.stringify({ data: { refreshIntervalSec: 5 } }));
            const { getSettings, reloadSettingsFile, settingsFileStatus, updateSettings } = await loadStore();
            getSettings();
            writeFileSync(configFile, '{ "data": ');
            expect(reloadSettingsFile()?.after).toEqual(DEFAULT_SETTINGS);
            expect(settingsFileStatus().blocked).toBe(true);
            updateSettings({ general: { confirmQuit: false } });
            expect(readFileSync(configFile, 'utf8')).toBe('{ "data": ');

            writeFileSync(configFile, JSON.stringify({ data: { refreshIntervalSec: 10 } }));
            reloadSettingsFile();
            expect(settingsFileStatus().blocked).toBe(false);
            // The file is what the app runs on again, not the change it could not save.
            expect(getSettings().general.confirmQuit).toBe(true);
            expect(getSettings().data.refreshIntervalSec).toBe(10);
        });

        it('goes back to the defaults when the file is deleted', async () => {
            writeFileSync(configFile, JSON.stringify({ data: { refreshIntervalSec: 5 } }));
            const { getSettings, reloadSettingsFile } = await loadStore();
            getSettings();
            rmSync(configFile);
            expect(reloadSettingsFile()?.after).toEqual(DEFAULT_SETTINGS);
        });

        it('is noticed by the watch within its polling interval, and not after the watch stops', async () => {
            writeFileSync(configFile, JSON.stringify({ data: { refreshIntervalSec: 5 } }));
            const { getSettings, watchSettingsFile } = await loadStore();
            getSettings();
            const onChange = vi.fn();
            const stop = watchSettingsFile(onChange);
            try {
                // Written until noticed: the watch takes its first reading asynchronously, and an edit
                // landing before that reading is the baseline rather than a change. Writing the same
                // text again is no change either, so the listener still hears exactly one.
                await vi.waitFor(
                    () => {
                        writeFileSync(configFile, JSON.stringify({ data: { refreshIntervalSec: 30 } }));
                        expect(onChange).toHaveBeenCalled();
                    },
                    { timeout: 10_000, interval: 250 },
                );
                expect(onChange).toHaveBeenCalledOnce();
                expect(onChange.mock.calls[0]?.[0].after.data.refreshIntervalSec).toBe(30);
            } finally {
                stop();
            }
            writeFileSync(configFile, JSON.stringify({ data: { refreshIntervalSec: 60 } }));
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            expect(onChange).toHaveBeenCalledOnce();
        }, 15_000);
    });

    it('survives a write failure without throwing', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        // A file where the state file's directory should be makes the write fail.
        rmSync(userData, { recursive: true });
        writeFileSync(userData, 'not a directory');
        const { updateSettings } = await loadStore();
        expect(() => updateSettings({ session: { lastNamespace: 'web' } })).not.toThrow();
        expect(error).toHaveBeenCalledOnce();
    });
});
