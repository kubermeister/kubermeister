import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HelmStatus } from '../../shared/helm-tool.js';

/**
 * Helm is the one program outside the app that the app runs, and it runs it only to render a chart:
 * no JavaScript implementation of Go templates, Sprig and Helm's own functions renders a chart the
 * way Helm does. It is the user's own `helm`, found on the PATH main adopted from the login shell,
 * and it is kept away from everything the user's Helm would otherwise read — their kubeconfig, their
 * repositories, their plugins — so the only thing it can do is turn a chart and values into YAML.
 * Every write still goes through the app's own write path.
 */

/** Helm 2 rendered through Tiller and spoke another chart API; nothing older than 3 is accepted. */
export const MIN_HELM_MAJOR = 3;

/** `helm version` is instant; one that is not is a binary that will not render either. */
export const HELM_VERSION_TIMEOUT_MS = 10_000;

/** How much a child may print before it is stopped: far past any real chart, well short of a runaway. */
export const HELM_OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;

/** The default ceiling for one run, for a chart with many subcharts on a slow machine. */
export const HELM_TIMEOUT_MS = 60_000;

export interface HelmBinary {
    path: string;
    version: string;
}

export interface HelmLookupOptions {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    spawn?: typeof nodeSpawn;
}

/** The version `helm version --short` printed, without its `v` and build metadata, or null for Helm 2 and noise. */
export function parseHelmVersion(output: string): string | null {
    const line = output.trim().split('\n')[0]?.trim() ?? '';
    const match = /^v?((\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?$/.exec(line);
    if (!match || Number(match[2]) < MIN_HELM_MAJOR) return null;
    return match[1]!;
}

function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
    if (platform !== 'win32') return env[name];
    // Windows environment names are case-insensitive, and PATH usually arrives as `Path`.
    const key = Object.keys(env).find((one) => one.toUpperCase() === name.toUpperCase());
    return key ? env[key] : undefined;
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
    try {
        if (!statSync(candidate).isFile()) return false;
        if (platform !== 'win32') accessSync(candidate, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * The first executable called `command` along PATH. A relative entry is skipped, since it would
 * resolve against whatever the working directory happens to be. On Windows only an `.exe` counts:
 * Node refuses to start a `.cmd` or `.bat` without a shell, and a shell is what this must not need.
 */
export function findOnPath(
    command: string,
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): string | null {
    const file = platform === 'win32' ? `${command}.exe` : command;
    const delimiter = platform === 'win32' ? ';' : ':';
    for (const dir of (envValue(env, 'PATH', platform) ?? '').split(delimiter)) {
        if (!dir || !path.isAbsolute(dir)) continue;
        const candidate = path.join(dir, file);
        if (isExecutableFile(candidate, platform)) return candidate;
    }
    return null;
}

/**
 * The whole environment a Helm child gets, built from nothing rather than filtered from the app's:
 * any `HELM_*` or `KUBE*` variable left in would be the user's Helm configuration reaching the
 * render. The kubeconfig is an empty file, so no subcommand could reach a cluster even if one were
 * asked to, and every Helm home is the throwaway directory. There is no PATH, since rendering
 * starts nothing, and no proxy, since it reaches no network.
 */
export function isolatedHelmEnv(
    home: string,
    platform: NodeJS.Platform = process.platform,
    inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const { join } = path;
    const env: NodeJS.ProcessEnv = {
        HOME: home,
        KUBECONFIG: join(home, 'kubeconfig'),
        HELM_CACHE_HOME: join(home, 'cache'),
        HELM_CONFIG_HOME: join(home, 'config'),
        HELM_DATA_HOME: join(home, 'data'),
        HELM_PLUGINS: join(home, 'plugins'),
    };
    if (platform === 'win32') {
        // A Go binary on Windows loads its system libraries through SystemRoot and fails without it.
        const systemRoot = envValue(inherited, 'SystemRoot', platform);
        if (systemRoot) env.SystemRoot = systemRoot;
        env.USERPROFILE = home;
        env.TEMP = home;
        env.TMP = home;
    } else {
        env.TMPDIR = home;
    }
    return env;
}

/**
 * Run `work` with a private scratch directory holding an empty kubeconfig, removed afterwards
 * whatever happens. The kubeconfig is written owner-only because Helm warns about a readable one.
 */
export async function withHelmHome<T>(work: (home: string) => Promise<T> | T): Promise<T> {
    const home = await mkdtemp(path.join(tmpdir(), 'kubermeister-helm-'));
    try {
        await writeFile(path.join(home, 'kubeconfig'), '', { mode: 0o600 });
        return await work(home);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
}

export type HelmRun =
    | { ok: true; code: number | null; stdout: string; stderr: string }
    | { ok: false; failure: 'timeout' }
    | { ok: false; failure: 'tooLarge' }
    | { ok: false; failure: 'spawn'; message: string };

export interface HelmRunOptions {
    env: NodeJS.ProcessEnv;
    cwd: string;
    spawn?: typeof nodeSpawn;
    timeoutMs?: number;
    maxOutputBytes?: number;
}

/** One Helm run under a ceiling on time and on output, killed when it passes either. Never throws. */
export function runHelm(binary: string, args: string[], options: HelmRunOptions): Promise<HelmRun> {
    const spawn = options.spawn ?? nodeSpawn;
    const timeoutMs = options.timeoutMs ?? HELM_TIMEOUT_MS;
    const limit = options.maxOutputBytes ?? HELM_OUTPUT_LIMIT_BYTES;

    return new Promise((resolve) => {
        let child: ReturnType<typeof nodeSpawn>;
        try {
            child = spawn(binary, args, { env: options.env, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            resolve({ ok: false, failure: 'spawn', message: (error as Error).message });
            return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = (result: HelmRun) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const stop = (failure: 'timeout' | 'tooLarge') => {
            child.kill();
            finish({ ok: false, failure });
        };
        const timer = setTimeout(() => stop('timeout'), timeoutMs);
        const collect = (into: Buffer[]) => (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) return stop('tooLarge');
            into.push(chunk);
        };
        child.stdout?.on('data', collect(stdout));
        child.stderr?.on('data', collect(stderr));
        child.on('error', (error) => finish({ ok: false, failure: 'spawn', message: error.message }));
        child.on('close', (code: number | null) =>
            finish({
                ok: true,
                code,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            }),
        );
    });
}

/**
 * The version is asked once per binary, recognised by its path, size and modification time, so a
 * screen asking again costs a stat and an upgrade is noticed. A missing Helm is never remembered:
 * one installed while the app runs is found on the next ask.
 */
let remembered: { key: string; binary: HelmBinary | null } | null = null;

export function resetHelmLookup(): void {
    remembered = null;
}

/** The `helm` a chart is rendered with, or null when there is none on PATH at Helm 3 or later. */
export async function findHelm(options: HelmLookupOptions = {}): Promise<HelmBinary | null> {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const binary = findOnPath('helm', env, platform);
    if (!binary) return null;
    let key: string;
    try {
        const stat = statSync(binary);
        key = `${binary}\n${stat.size}\n${stat.mtimeMs}`;
    } catch {
        return null;
    }
    if (remembered?.key === key) return remembered.binary;

    const run = await withHelmHome((home) =>
        runHelm(binary, ['version', '--short'], {
            env: isolatedHelmEnv(home, platform, env),
            cwd: home,
            spawn: options.spawn,
            timeoutMs: HELM_VERSION_TIMEOUT_MS,
        }),
    );
    const version = run.ok && run.code === 0 ? parseHelmVersion(run.stdout) : null;
    const found = version ? { path: binary, version } : null;
    remembered = { key, binary: found };
    return found;
}

/** What the screens that need Helm are told: whether it was found, where and at which version. */
export async function helmStatus(options: HelmLookupOptions = {}): Promise<HelmStatus> {
    const binary = await findHelm(options);
    return binary ? { found: true, ...binary } : { found: false };
}
