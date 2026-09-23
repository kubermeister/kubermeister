import { z } from 'zod';
import { chartRepositorySchema, MAX_CHART_REPOSITORIES } from './charts.js';

/**
 * Persisted application settings: the app's own durable state, written to a JSON file the main
 * process owns (`src/main/settings/store.ts`). Recording the last selected context and namespace
 * here never mutates the kubeconfig on disk, so the kubeconfig stays read-only.
 */

const sessionSchema = z.object({
    /** The context the app reopens on: its own pointer, not the kubeconfig's current-context. */
    lastContext: z.string().nullable(),
    lastNamespace: z.string().nullable(),
    /** When false, launch follows the kubeconfig's current-context instead of `lastContext`. */
    restoreOnLaunch: z.boolean(),
});

/** Preferences about the app itself rather than about a cluster. */
const generalSchema = z.object({
    /**
     * Whether quitting asks first. On, because quitting ends every port forward, shell, log follow
     * and drain at once, and none of them come back.
     */
    confirmQuit: z.boolean(),
});

const connectionSchema = z.object({
    /** Kubeconfig file to read; null means the default ($KUBECONFIG or ~/.kube/config). */
    kubeconfigPath: z.string().nullable(),
});

/** Live-refresh cadences offered in Settings, in seconds. */
export const REFRESH_INTERVAL_OPTIONS = [5, 10, 15, 30, 60] as const;

/**
 * Read ceilings offered in Settings, in seconds. A ceiling is a judgement about how big a cluster
 * may be, so it is the user's to make: a list of thousands of pods takes longer than any default.
 */
export const READ_TIMEOUT_OPTIONS = [15, 30, 60, 120, 300] as const;

/** Log buffer sizes offered in Settings, in lines. */
export const LOG_BUFFER_OPTIONS = [2_000, 10_000, 50_000] as const;

/** Terminal font sizes offered in Settings, in points. */
export const TERMINAL_FONT_SIZES = [11, 12, 14, 16] as const;

/** One forward worth offering again: what it pointed at, and where it listened. */
export const rememberedForwardSchema = z.object({
    context: z.string().min(1),
    kind: z.enum(['Pod', 'Service']),
    namespace: z.string().min(1),
    name: z.string().min(1),
    targetPort: z.number().int().min(1).max(65535),
    localPort: z.number().int().min(1).max(65535),
});

const dataSchema = z.object({
    /** Poll cadence for the live lists, metrics and dashboard queries. */
    refreshIntervalSec: z.number().int().positive(),
    /** Ceiling on one cluster read before it is reported as timed out. Under 5 s cuts real clusters short. */
    readTimeoutSec: z.number().int().min(5).max(600),
    /** How many log lines a live follow keeps before dropping the oldest. */
    logBufferLines: z.number().int().positive(),
    /** Font size of the shell terminals, in points. */
    terminalFontSize: z.number().int().min(8).max(32),
    /** Forwards this app has opened, offered again on the context they belong to. */
    forwards: z.array(rememberedForwardSchema).max(50),
});

/**
 * How far the updater goes on its own: `check` finds new versions and lets the user start the
 * download, `download` fetches them in the background and asks only to restart, `off` never checks
 * unless asked to from Settings or the menu.
 */
export const UPDATE_MODES = ['check', 'download', 'off'] as const;

export type UpdateMode = (typeof UPDATE_MODES)[number];

/**
 * What an unset mode means. The app releases often and installs on quit, so a version that has been
 * found is worth having on disk: an announcement the user has to act on leaves a fix sitting behind
 * a click nobody has a reason to make, which is how a release can reach a machine that was told
 * about it and never take.
 */
export const DEFAULT_UPDATE_MODE: UpdateMode = 'download';

/** Scheduled update check cadences offered in Settings, in hours. */
export const UPDATE_CHECK_INTERVAL_OPTIONS = [1, 4, 12, 24] as const;

const updatesSchema = z.object({
    /** The mode the user picked, or null for {@link DEFAULT_UPDATE_MODE}, so changing it moves them too. */
    mode: z.enum(UPDATE_MODES).nullable(),
    /** Hours between scheduled checks; how often the app reaches out is the user's to decide. */
    checkIntervalHours: z.number().int().min(1).max(168),
});

/**
 * Where the proxy for a cluster call comes from. `env` follows the proxy variables the environment
 * sets, the way kubectl does; `manual` uses the one named here and nothing else; `off` connects
 * straight out whatever the environment says. A cluster whose kubeconfig entry carries its own
 * `proxy-url` always uses that: the file is the more specific answer and the app never rewrites it.
 */
export const PROXY_MODES = ['env', 'manual', 'off'] as const;

/** The schemes a proxy can speak; anything else is a typo, or a URL that means something else. */
const PROXY_SCHEMES = ['http:', 'https:', 'socks:', 'socks4:', 'socks5:', 'socks5h:'];

/** Whether a string is a proxy address the connection could actually be made through. */
export function isProxyUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return PROXY_SCHEMES.includes(url.protocol) && url.hostname.length > 0;
    } catch {
        return false;
    }
}

const networkSchema = z.object({
    /** Where the proxy comes from; see {@link PROXY_MODES}. */
    proxyMode: z.enum(PROXY_MODES),
    /** The proxy used under `manual`, as a full URL; null means no proxy at all. */
    proxyUrl: z.string().refine(isProxyUrl, 'Expected an http, https or socks proxy URL.').nullable(),
    /** Hosts that never go through a proxy, spelled as `NO_PROXY` spells them; null follows `NO_PROXY` itself. */
    noProxy: z.string().nullable(),
    /** A PEM file of extra certificate authorities to trust for cluster TLS, beside the usual ones. */
    caBundlePath: z.string().nullable(),
});

/**
 * Chart sources this install knows. Only what identifies a source lives here: its credential is in
 * the OS keychain and its index in a cache file beside this one, so the settings file stays
 * something a user can read, copy between machines and check into a dotfiles repository.
 */
const chartsSchema = z.object({
    repositories: z.array(chartRepositorySchema).max(MAX_CHART_REPOSITORIES),
});

const windowBoundsSchema = z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
});

const windowSchema = z.object({
    /** Where the window last stood; null until it has been closed once. */
    bounds: windowBoundsSchema.nullable(),
});

/** The shape the file on disk is written in; {@link parseSettings} migrates every older one. */
export const SETTINGS_VERSION = 2;

export const settingsSchema = z.object({
    version: z.literal(SETTINGS_VERSION),
    general: generalSchema,
    session: sessionSchema,
    connection: connectionSchema,
    data: dataSchema,
    updates: updatesSchema,
    network: networkSchema,
    charts: chartsSchema,
    window: windowSchema,
});

/** A partial patch the main process may apply: any subset of sections, each a partial of its shape. */
export const settingsPatchSchema = z.object({
    general: generalSchema.partial().optional(),
    session: sessionSchema.partial().optional(),
    connection: connectionSchema.partial().optional(),
    data: dataSchema.partial().optional(),
    updates: updatesSchema.partial().optional(),
    network: networkSchema.partial().optional(),
    charts: chartsSchema.partial().optional(),
    window: windowSchema.partial().optional(),
});

/**
 * What the renderer may set through `settings.set`. Every file path is excluded on purpose: pointing
 * the app at an arbitrary file is a native-dialog action (`kubeconfig.pick`, `caBundle.pick`), never
 * a raw renderer-supplied string, so a compromised renderer cannot probe files or trigger exec
 * plugins. The rest of the network section is an ordinary preference and stays settable.
 *
 * The chart repositories are excluded for a different reason: adding or removing one also writes
 * the OS keychain and the on-disk index cache, so the list is only ever edited through the
 * `chartRepositories.*` channels, which keep all three in step.
 */
export const settingsInputSchema = settingsPatchSchema
    .omit({ connection: true, window: true, network: true, charts: true })
    .extend({ network: networkSchema.omit({ caBundlePath: true }).partial().optional() });

export type GeneralSettings = z.infer<typeof generalSchema>;
export type RememberedForward = z.infer<typeof rememberedForwardSchema>;
export type ChartSettings = z.infer<typeof chartsSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export type SettingsInput = z.infer<typeof settingsInputSchema>;
export type WindowBounds = z.infer<typeof windowBoundsSchema>;
export type NetworkSettings = z.infer<typeof networkSchema>;
export type ProxyMode = (typeof PROXY_MODES)[number];

export const DEFAULT_SETTINGS: Settings = {
    version: SETTINGS_VERSION,
    general: { confirmQuit: true },
    session: { lastContext: null, lastNamespace: null, restoreOnLaunch: true },
    connection: { kubeconfigPath: null },
    data: { refreshIntervalSec: 12, readTimeoutSec: 60, logBufferLines: 2_000, terminalFontSize: 12, forwards: [] },
    updates: { mode: null, checkIntervalHours: 4 },
    network: { proxyMode: 'env', proxyUrl: null, noProxy: null, caBundlePath: null },
    charts: { repositories: [] },
    window: { bounds: null },
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every section, by the name it has in the file, with the schema its keys are checked against. */
const SECTION_SCHEMAS = {
    general: generalSchema,
    session: sessionSchema,
    connection: connectionSchema,
    data: dataSchema,
    updates: updatesSchema,
    network: networkSchema,
    charts: chartsSchema,
    window: windowSchema,
} as const;

export type SettingsSection = keyof typeof SECTION_SCHEMAS;

export const SETTINGS_SECTIONS = Object.keys(SECTION_SCHEMAS) as SettingsSection[];

/**
 * What the app records about itself rather than what anybody configures: where it was, what it
 * last opened, where the window stood. These live in a state file beside the app's caches, so the
 * settings file holds only what a user would write by hand, copy between machines or provision.
 */
export const STATE_KEYS: { readonly [S in SettingsSection]?: readonly (keyof Settings[S])[] } = {
    session: ['lastContext', 'lastNamespace'],
    data: ['forwards'],
    window: ['bounds'],
};

export function isStateKey(section: string, key: string): boolean {
    const keys: readonly string[] | undefined = STATE_KEYS[section as SettingsSection];
    return keys?.includes(key) ?? false;
}

/** Keys a settings file may carry beside its sections. */
const FILE_KEYS = new Set(['version', '$schema']);

/** One value the file carried that was not used, and why; the path is dotted, `data.readTimeoutSec`. */
export interface SettingsProblem {
    path: string;
    message: string;
}

export interface SettingsRead {
    settings: Settings;
    problems: SettingsProblem[];
    /** The file names a version newer than this app knows. */
    newer: boolean;
}

/**
 * A version 1 file recorded no difference between a mode the user picked and the default the app
 * wrote back with every save, and that default was `check`, so the `check` such a file carries is
 * read as no choice at all and follows {@link DEFAULT_UPDATE_MODE}. `download` and `off` were only
 * ever written by somebody choosing them, so they survive untouched.
 */
function migrateV1(file: Record<string, unknown>): Record<string, unknown> {
    if (!isRecord(file.updates) || file.updates.mode !== 'check') return file;
    const { mode: _chosenByDefault, ...updates } = file.updates;
    return { ...file, updates };
}

/**
 * The file migrated to the current version. A file naming no version is taken as the current one,
 * since that is what somebody writing it by hand means; a version this app does not know is read
 * as it stands, for whatever of it still validates.
 */
export function migrateSettingsDocument(raw: Record<string, unknown>): Record<string, unknown> {
    const migrated = raw.version === 1 ? migrateV1(raw) : raw;
    return raw.version === undefined || raw.version === 1 ? { ...migrated, version: SETTINGS_VERSION } : migrated;
}

function describeIssue(error: z.ZodError): string {
    return error.issues[0]?.message ?? 'Invalid value.';
}

/**
 * One section, key by key over its defaults: a value that fails falls back to its own default and
 * is named as a problem, so one typo never takes the rest of its section with it. A key the app
 * records itself is read from the state file first, then from the settings file, where every
 * install before the state file existed kept it.
 */
function readSection<S extends SettingsSection>(
    name: S,
    config: unknown,
    state: unknown,
    problems: SettingsProblem[],
): Settings[S] {
    const schema: z.ZodObject<z.ZodRawShape> = SECTION_SCHEMAS[name];
    const fallback: Record<string, unknown> = DEFAULT_SETTINGS[name];
    if (config !== undefined && !isRecord(config)) problems.push({ path: name, message: 'Expected an object.' });
    const fromConfig = isRecord(config) ? config : {};
    const fromState = isRecord(state) ? state : {};
    const candidate: Record<string, unknown> = { ...fallback };
    for (const [key, keySchema] of Object.entries(schema.shape)) {
        const value = isStateKey(name, key) && key in fromState ? fromState[key] : fromConfig[key];
        if (value === undefined) continue;
        const result = z.safeParse(keySchema, value);
        if (result.success) candidate[key] = result.data;
        else problems.push({ path: `${name}.${key}`, message: describeIssue(result.error) });
    }
    for (const key of Object.keys(fromConfig)) {
        if (!(key in schema.shape)) problems.push({ path: `${name}.${key}`, message: 'Unknown setting, ignored.' });
    }
    // Every key was checked on its own above, so the section as a whole cannot fail here.
    return SECTION_SCHEMAS[name].parse(candidate) as Settings[S];
}

/**
 * Read the settings file and the state file into valid {@link Settings}; never throws. Either may
 * be anything at all: a missing or unreadable file contributes nothing, and every value that is
 * not used is named in `problems`.
 */
export function readSettings(config: unknown, state?: unknown): SettingsRead {
    const problems: SettingsProblem[] = [];
    const file = isRecord(config) ? migrateSettingsDocument(config) : {};
    const version = file.version;
    const newer = typeof version === 'number' && version > SETTINGS_VERSION;
    if (newer) {
        problems.push({
            path: 'version',
            message: `Written by a newer Kubermeister (settings version ${version}); only what this version understands is used.`,
        });
    } else if (isRecord(config) && version !== SETTINGS_VERSION) {
        problems.push({ path: 'version', message: `Unknown settings version ${JSON.stringify(version)}.` });
    }
    for (const key of Object.keys(file)) {
        if (!FILE_KEYS.has(key) && !(key in SECTION_SCHEMAS)) {
            problems.push({ path: key, message: 'Unknown section, ignored.' });
        }
    }
    const states = isRecord(state) ? state : {};
    const section = <S extends SettingsSection>(name: S) => readSection(name, file[name], states[name], problems);
    const settings: Settings = {
        version: SETTINGS_VERSION,
        general: section('general'),
        session: section('session'),
        connection: section('connection'),
        data: section('data'),
        updates: section('updates'),
        network: section('network'),
        charts: section('charts'),
        window: section('window'),
    };
    return { settings, problems, newer };
}

/** Coerce arbitrary parsed JSON into valid {@link Settings}; never throws. */
export function parseSettings(raw: unknown): Settings {
    return readSettings(raw).settings;
}

/** Merge a patch over current settings, section by section; a supplied section replaces only its own keys. */
export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
    return {
        version: current.version,
        general: { ...current.general, ...patch.general },
        session: { ...current.session, ...patch.session },
        connection: { ...current.connection, ...patch.connection },
        data: { ...current.data, ...patch.data },
        updates: { ...current.updates, ...patch.updates },
        network: { ...current.network, ...patch.network },
        charts: { ...current.charts, ...patch.charts },
        window: { ...current.window, ...patch.window },
    };
}
