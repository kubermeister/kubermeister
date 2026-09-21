import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SETTINGS,
    isProxyUrl,
    mergeSettings,
    parseSettings,
    settingsInputSchema,
    settingsPatchSchema,
} from '../../../src/shared/settings';

describe('parseSettings', () => {
    it('returns valid settings unchanged', () => {
        const valid = {
            version: 1,
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
            network: {
                proxyMode: 'manual',
                proxyUrl: 'http://proxy.corp:3128',
                noProxy: '.corp.example',
                caBundlePath: '/etc/corp/ca.pem',
            },
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
        expect(parseSettings({ ...DEFAULT_SETTINGS, version: 2 })).toEqual(DEFAULT_SETTINGS);
    });

    it('resets only the section whose field has the wrong type', () => {
        const bad = {
            version: 1,
            session: { lastContext: 'prod', lastNamespace: null, restoreOnLaunch: 'yes' },
            connection: { kubeconfigPath: '/tmp/k' },
        };
        const parsed = parseSettings(bad);
        expect(parsed.session).toEqual(DEFAULT_SETTINGS.session);
        expect(parsed.connection).toEqual({ kubeconfigPath: '/tmp/k' });
    });

    it('fills missing keys and sections with defaults and drops unknown keys', () => {
        const partial = { version: 1, session: { lastContext: 'staging', bogus: 1 } };
        expect(parseSettings(partial)).toEqual({
            version: 1,
            session: { lastContext: 'staging', lastNamespace: null, restoreOnLaunch: true },
            connection: { kubeconfigPath: null },
            data: {
                refreshIntervalSec: 12,
                readTimeoutSec: 60,
                logBufferLines: 2000,
                terminalFontSize: 12,
                forwards: [],
            },
            updates: { mode: 'check', checkIntervalHours: 4 },
            network: { proxyMode: 'env', proxyUrl: null, noProxy: null, caBundlePath: null },
            window: { bounds: null },
        });
    });

    it('starts existing installs on notify-first updates every four hours and rejects unknown values', () => {
        const defaults = { mode: 'check', checkIntervalHours: 4 };
        expect(parseSettings({ version: 1 }).updates).toEqual(defaults);
        // A file from before the interval existed keeps its mode and gains the default cadence.
        expect(parseSettings({ version: 1, updates: { mode: 'off' } }).updates).toEqual({ ...defaults, mode: 'off' });
        expect(parseSettings({ version: 1, updates: { mode: 'always' } }).updates).toEqual(defaults);
        expect(parseSettings({ version: 1, updates: { checkIntervalHours: 24 } }).updates).toEqual({
            ...defaults,
            checkIntervalHours: 24,
        });
        for (const bad of [0, -1, 1.5, 200, 'daily']) {
            expect(parseSettings({ version: 1, updates: { checkIntervalHours: bad } }).updates).toEqual(defaults);
        }
    });

    it('forgets saved window bounds that are not a full rectangle', () => {
        expect(parseSettings({ version: 1, window: { bounds: { x: 0, y: 0, width: 800 } } }).window).toEqual({
            bounds: null,
        });
        const bounds = { x: 10, y: 20, width: 800, height: 600 };
        expect(parseSettings({ version: 1, window: { bounds } }).window).toEqual({ bounds });
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
        expect(parseSettings({ version: 1, data: { refreshIntervalSec: 'soon' } }).data).toEqual(defaults);
        expect(parseSettings({ version: 1, data: { ...good, refreshIntervalSec: 0 } }).data).toEqual(defaults);
        expect(parseSettings({ version: 1, data: { ...good, logBufferLines: 0 } }).data).toEqual(defaults);
        // A read ceiling under five seconds cuts every real cluster short; over ten minutes is a hang.
        expect(parseSettings({ version: 1, data: { ...good, readTimeoutSec: 1 } }).data).toEqual(defaults);
        expect(parseSettings({ version: 1, data: { ...good, readTimeoutSec: 601 } }).data).toEqual(defaults);
        expect(parseSettings({ version: 1, data: { ...good, readTimeoutSec: 5 } }).data.readTimeoutSec).toBe(5);
        expect(parseSettings({ version: 1, data: { ...good, terminalFontSize: 99 } }).data).toEqual(defaults);
        expect(parseSettings({ version: 1, data: good }).data).toEqual(good);
    });
});

describe('the network section', () => {
    const defaults = { proxyMode: 'env', proxyUrl: null, noProxy: null, caBundlePath: null };

    it('starts existing installs on the environment proxy and no CA bundle', () => {
        expect(parseSettings({ version: 1 }).network).toEqual(defaults);
        expect(DEFAULT_SETTINGS.network).toEqual(defaults);
    });

    it('keeps a usable proxy of every supported kind', () => {
        for (const proxyUrl of [
            'http://proxy.corp:3128',
            'https://proxy.corp:3129',
            'socks5://proxy.corp:1080',
            'http://user:secret@proxy.corp:3128',
        ]) {
            expect(parseSettings({ version: 1, network: { proxyUrl } }).network.proxyUrl).toBe(proxyUrl);
        }
    });

    it('resets the section rather than keeping a proxy that is not a proxy URL', () => {
        for (const proxyUrl of ['proxy.corp:3128', 'file:///etc/passwd', 'ftp://proxy.corp', 'not a url', '']) {
            expect(parseSettings({ version: 1, network: { proxyUrl } }).network).toEqual(defaults);
        }
        expect(parseSettings({ version: 1, network: { proxyMode: 'sometimes' } }).network).toEqual(defaults);
    });

    it('refuses the CA bundle path from the renderer input schema, like every other path', () => {
        const parsed = settingsInputSchema.safeParse({ network: { caBundlePath: '/etc/passwd' } });
        expect(parsed.success && 'caBundlePath' in (parsed.data.network ?? {})).toBe(false);
    });

    it('lets the renderer choose the proxy, its bypass list and none at all', () => {
        expect(settingsInputSchema.safeParse({ network: { proxyMode: 'off' } }).success).toBe(true);
        expect(
            settingsInputSchema.safeParse({ network: { proxyMode: 'manual', proxyUrl: 'http://proxy:3128' } }).success,
        ).toBe(true);
        expect(settingsInputSchema.safeParse({ network: { noProxy: '.corp.example, 10.0.0.0/8' } }).success).toBe(true);
        expect(settingsInputSchema.safeParse({ network: { proxyUrl: 'javascript:alert(1)' } }).success).toBe(false);
        expect(settingsInputSchema.safeParse({ network: { proxyMode: 'maybe' } }).success).toBe(false);
    });

    it('merges into the section without disturbing the rest of it', () => {
        const merged = mergeSettings(DEFAULT_SETTINGS, { network: { proxyMode: 'manual' } });
        expect(merged.network).toEqual({ ...defaults, proxyMode: 'manual' });
        expect(mergeSettings(merged, { network: { caBundlePath: '/ca.pem' } }).network.proxyMode).toBe('manual');
    });
});

describe('isProxyUrl', () => {
    it('accepts the schemes a proxy can speak and nothing else', () => {
        expect(isProxyUrl('http://proxy:3128')).toBe(true);
        expect(isProxyUrl('socks5h://proxy:1080')).toBe(true);
        expect(isProxyUrl('http://proxy')).toBe(true);
        expect(isProxyUrl('http://')).toBe(false);
        expect(isProxyUrl('ws://proxy:3128')).toBe(false);
        expect(isProxyUrl('proxy:3128')).toBe(false);
        expect(isProxyUrl('')).toBe(false);
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
        expect(mergeSettings(DEFAULT_SETTINGS, { session: { lastNamespace: 'x' } }).version).toBe(1);
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

    it('lets the renderer change the update mode', () => {
        expect(settingsInputSchema.safeParse({ updates: { mode: 'off' } }).success).toBe(true);
        expect(settingsInputSchema.safeParse({ updates: { mode: 'sometimes' } }).success).toBe(false);
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
