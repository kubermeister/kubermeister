import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SETTINGS,
    SETTINGS_VERSION,
    mergeSettings,
    parseSettings,
    settingsInputSchema,
    settingsPatchSchema,
} from '../../../src/shared/settings';

describe('parseSettings', () => {
    it('returns valid settings unchanged', () => {
        const valid = {
            version: SETTINGS_VERSION,
            session: { lastContext: 'prod', lastNamespace: 'default', restoreOnLaunch: true },
            connection: { kubeconfigPath: '/tmp/kubeconfig' },
            data: {
                refreshIntervalSec: 30,
                readTimeoutSec: 120,
                logBufferLines: 2000,
                terminalFontSize: 12,
                forwards: [],
            },
            updates: { mode: 'download', checkIntervalHours: 12 },
            charts: { repositories: [{ name: 'bitnami', kind: 'classic', url: 'https://charts.example.com' }] },
            window: { bounds: { x: 0, y: 0, width: 1200, height: 800 } },
        };
        expect(parseSettings(valid)).toEqual(valid);
    });

    it('falls back to defaults on corrupt or non-object input', () => {
        expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
        expect(parseSettings('not json')).toEqual(DEFAULT_SETTINGS);
        expect(parseSettings({ garbage: true })).toEqual(DEFAULT_SETTINGS);
        expect(parseSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
    });

    it('falls back to defaults on an unknown version', () => {
        expect(parseSettings({ ...DEFAULT_SETTINGS, version: 99 })).toEqual(DEFAULT_SETTINGS);
        expect(parseSettings({ ...DEFAULT_SETTINGS, version: '2' })).toEqual(DEFAULT_SETTINGS);
    });

    it('resets only the section whose field has the wrong type', () => {
        const bad = {
            version: SETTINGS_VERSION,
            session: { lastContext: 'prod', lastNamespace: null, restoreOnLaunch: 'yes' },
            connection: { kubeconfigPath: '/tmp/k' },
        };
        const parsed = parseSettings(bad);
        expect(parsed.session).toEqual(DEFAULT_SETTINGS.session);
        expect(parsed.connection).toEqual({ kubeconfigPath: '/tmp/k' });
    });

    it('fills missing keys and sections with defaults and drops unknown keys', () => {
        const partial = { version: SETTINGS_VERSION, session: { lastContext: 'staging', bogus: 1 } };
        expect(parseSettings(partial)).toEqual({
            version: SETTINGS_VERSION,
            session: { lastContext: 'staging', lastNamespace: null, restoreOnLaunch: true },
            connection: { kubeconfigPath: null },
            data: {
                refreshIntervalSec: 12,
                readTimeoutSec: 60,
                logBufferLines: 2000,
                terminalFontSize: 12,
                forwards: [],
            },
            updates: { mode: null, checkIntervalHours: 4 },
            charts: { repositories: [] },
            window: { bounds: null },
        });
    });

    it('leaves the update mode unset until it is chosen, every four hours, and rejects unknown values', () => {
        const defaults = { mode: null, checkIntervalHours: 4 };
        expect(parseSettings({ version: SETTINGS_VERSION }).updates).toEqual(defaults);
        // A file from before the interval existed keeps its mode and gains the default cadence.
        expect(parseSettings({ version: SETTINGS_VERSION, updates: { mode: 'off' } }).updates).toEqual({
            ...defaults,
            mode: 'off',
        });
        expect(parseSettings({ version: SETTINGS_VERSION, updates: { mode: 'always' } }).updates).toEqual(defaults);
        expect(parseSettings({ version: SETTINGS_VERSION, updates: { checkIntervalHours: 24 } }).updates).toEqual({
            ...defaults,
            checkIntervalHours: 24,
        });
        for (const bad of [0, -1, 1.5, 200, 'daily']) {
            expect(parseSettings({ version: SETTINGS_VERSION, updates: { checkIntervalHours: bad } }).updates).toEqual(
                defaults,
            );
        }
    });

    it('starts an install with no chart repositories, and keeps only entries it can use', () => {
        // Nothing before version 2 had a charts section at all.
        expect(parseSettings({ version: 1 }).charts).toEqual({ repositories: [] });
        const bitnami = { name: 'bitnami', kind: 'classic', url: 'https://charts.example.com' };
        expect(
            parseSettings({ version: SETTINGS_VERSION, charts: { repositories: [bitnami] } }).charts.repositories,
        ).toEqual([bitnami]);
        // The section is parsed as a whole, so one unusable entry takes the list with it rather
        // than leaving a repository behind whose name could become a cache path.
        for (const bad of [{ ...bitnami, name: '../escape' }, { ...bitnami, kind: 'git' }, { name: 'bitnami' }]) {
            expect(parseSettings({ version: SETTINGS_VERSION, charts: { repositories: [bad] } }).charts).toEqual({
                repositories: [],
            });
        }
    });

    describe('migrating a version 1 file', () => {
        it('reads the old default as no choice, so the current default applies', () => {
            expect(parseSettings({ version: 1, updates: { mode: 'check', checkIntervalHours: 12 } }).updates).toEqual({
                mode: null,
                checkIntervalHours: 12,
            });
            expect(parseSettings({ version: 1 }).updates).toEqual({ mode: null, checkIntervalHours: 4 });
        });

        it('keeps a mode nobody but the user could have written', () => {
            expect(parseSettings({ version: 1, updates: { mode: 'off' } }).updates.mode).toBe('off');
            expect(parseSettings({ version: 1, updates: { mode: 'download' } }).updates.mode).toBe('download');
        });

        it('carries every other section across unchanged and stamps the new version', () => {
            const v1 = {
                version: 1,
                session: { lastContext: 'prod', lastNamespace: 'team-a', restoreOnLaunch: false },
                connection: { kubeconfigPath: '/tmp/kubeconfig' },
                updates: { mode: 'check', checkIntervalHours: 24 },
                window: { bounds: { x: 1, y: 2, width: 800, height: 600 } },
            };
            const parsed = parseSettings(v1);
            expect(parsed.version).toBe(SETTINGS_VERSION);
            expect(parsed.session).toEqual(v1.session);
            expect(parsed.connection).toEqual(v1.connection);
            expect(parsed.window).toEqual(v1.window);
        });

        it('is not applied a second time once the migrated file has been written back', () => {
            const migrated = parseSettings({ version: 1, updates: { mode: 'check', checkIntervalHours: 4 } });
            const chosen = mergeSettings(migrated, { updates: { mode: 'check' } });
            expect(parseSettings(chosen).updates.mode).toBe('check');
        });
    });

    it('forgets saved window bounds that are not a full rectangle', () => {
        expect(
            parseSettings({ version: SETTINGS_VERSION, window: { bounds: { x: 0, y: 0, width: 800 } } }).window,
        ).toEqual({ bounds: null });
        const bounds = { x: 10, y: 20, width: 800, height: 600 };
        expect(parseSettings({ version: SETTINGS_VERSION, window: { bounds } }).window).toEqual({ bounds });
    });

    it('resets a data section that is not usable, keeping one that is', () => {
        // The section is parsed as a whole, so one bad field takes the section's defaults with it.
        const defaults = {
            refreshIntervalSec: 12,
            readTimeoutSec: 60,
            logBufferLines: 2000,
            terminalFontSize: 12,
            forwards: [],
        };
        const good = {
            refreshIntervalSec: 30,
            readTimeoutSec: 300,
            logBufferLines: 10_000,
            terminalFontSize: 14,
            forwards: [],
        };
        expect(parseSettings({ version: SETTINGS_VERSION, data: { refreshIntervalSec: 'soon' } }).data).toEqual(
            defaults,
        );
        expect(parseSettings({ version: SETTINGS_VERSION, data: { ...good, refreshIntervalSec: 0 } }).data).toEqual(
            defaults,
        );
        expect(parseSettings({ version: SETTINGS_VERSION, data: { ...good, logBufferLines: 0 } }).data).toEqual(
            defaults,
        );
        // A read ceiling under five seconds cuts every real cluster short; over ten minutes is a hang.
        expect(parseSettings({ version: SETTINGS_VERSION, data: { ...good, readTimeoutSec: 1 } }).data).toEqual(
            defaults,
        );
        expect(parseSettings({ version: SETTINGS_VERSION, data: { ...good, readTimeoutSec: 601 } }).data).toEqual(
            defaults,
        );
        expect(
            parseSettings({ version: SETTINGS_VERSION, data: { ...good, readTimeoutSec: 5 } }).data.readTimeoutSec,
        ).toBe(5);
        expect(parseSettings({ version: SETTINGS_VERSION, data: { ...good, terminalFontSize: 99 } }).data).toEqual(
            defaults,
        );
        expect(parseSettings({ version: SETTINGS_VERSION, data: good }).data).toEqual(good);
    });
});

describe('mergeSettings', () => {
    it('merges a section patch while preserving the other sections', () => {
        const merged = mergeSettings(DEFAULT_SETTINGS, { connection: { kubeconfigPath: '/k' } });
        expect(merged.connection.kubeconfigPath).toBe('/k');
        expect(merged.session).toEqual(DEFAULT_SETTINGS.session);
    });

    it('replaces only the supplied keys within a section', () => {
        const merged = mergeSettings(DEFAULT_SETTINGS, { session: { lastContext: 'staging' } });
        expect(merged.session.lastContext).toBe('staging');
        expect(merged.session.restoreOnLaunch).toBe(DEFAULT_SETTINGS.session.restoreOnLaunch);
        expect(merged.session.lastNamespace).toBe(DEFAULT_SETTINGS.session.lastNamespace);
    });

    it('is a no-op for an empty patch and keeps the version', () => {
        expect(mergeSettings(DEFAULT_SETTINGS, {})).toEqual(DEFAULT_SETTINGS);
        expect(mergeSettings(DEFAULT_SETTINGS, { session: { lastNamespace: 'x' } }).version).toBe(SETTINGS_VERSION);
    });
});

describe('patch schemas', () => {
    it('accepts partial sections in the main-process patch', () => {
        expect(settingsPatchSchema.safeParse({ connection: { kubeconfigPath: '/k' } }).success).toBe(true);
        expect(settingsPatchSchema.safeParse({ session: { restoreOnLaunch: 'no' } }).success).toBe(false);
    });

    it('refuses the kubeconfig path from the renderer input schema', () => {
        expect(settingsInputSchema.safeParse({ session: { lastNamespace: 'kube-system' } }).success).toBe(true);
        const withPath = settingsInputSchema.safeParse({ connection: { kubeconfigPath: '/etc/passwd' } });
        expect(withPath.success && 'connection' in withPath.data).toBe(false);
    });

    it('refuses the chart repositories from the renderer input schema', () => {
        // Adding one also writes the keychain and the index cache, so the list is never patched
        // straight into the settings file.
        const patch = settingsInputSchema.safeParse({ charts: { repositories: [] } });
        expect(patch.success && 'charts' in patch.data).toBe(false);
        expect(settingsPatchSchema.safeParse({ charts: { repositories: [] } }).success).toBe(true);
    });

    it('lets the renderer change the update mode', () => {
        expect(settingsInputSchema.safeParse({ updates: { mode: 'off' } }).success).toBe(true);
        expect(settingsInputSchema.safeParse({ updates: { mode: 'sometimes' } }).success).toBe(false);
        // Null is how a file says nobody chose, so the renderer may hand the choice back too.
        expect(settingsInputSchema.safeParse({ updates: { mode: null } }).success).toBe(true);
        expect(mergeSettings(DEFAULT_SETTINGS, { updates: { mode: 'download' } }).updates).toEqual({
            mode: 'download',
            checkIntervalHours: 4,
        });
        expect(settingsInputSchema.safeParse({ updates: { checkIntervalHours: 24 } }).success).toBe(true);
        expect(settingsInputSchema.safeParse({ updates: { checkIntervalHours: 0 } }).success).toBe(false);
    });

    it('lets the renderer change the refresh interval', () => {
        expect(
            settingsInputSchema.safeParse({
                data: {
                    refreshIntervalSec: 30,
                    logBufferLines: 2000,
                    terminalFontSize: 12,
                    forwards: [],
                },
            }).success,
        ).toBe(true);
        expect(settingsInputSchema.safeParse({ data: { refreshIntervalSec: -1 } }).success).toBe(false);
        expect(
            mergeSettings(DEFAULT_SETTINGS, {
                data: {
                    refreshIntervalSec: 60,
                    logBufferLines: 2000,
                    terminalFontSize: 12,
                    forwards: [],
                },
            }).data.refreshIntervalSec,
        ).toBe(60);
        expect(
            mergeSettings(DEFAULT_SETTINGS, {
                data: {
                    refreshIntervalSec: 60,
                    logBufferLines: 2000,
                    terminalFontSize: 12,
                    forwards: [],
                },
            }).session,
        ).toEqual(DEFAULT_SETTINGS.session);
    });
});
