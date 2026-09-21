import { spawn as nodeSpawn } from 'node:child_process';

/**
 * A GUI app launched from the Finder, the Dock or a desktop menu inherits launchd's minimal
 * environment, not the one the user's shell profile builds: PATH is
 * `/usr/bin:/bin:/usr/sbin:/sbin` and the proxy variables are not there at all. Kubeconfigs written
 * by `aws eks update-kubeconfig` or `gcloud container clusters get-credentials` name their
 * credential plugin by bare command, so with that PATH every exec-authenticated context fails with
 * `spawn aws ENOENT`; and behind a corporate proxy the same launch would reach no cluster while the
 * user's terminal reaches all of them. Asking the login shell once at startup, the way editors and
 * other Kubernetes clients do, is what makes both work unchanged.
 */

const MARKER = '__KM_ENV__';

/**
 * What is worth taking from the profile. Both spellings of each proxy variable are asked for,
 * because a profile may set either and the app honours either.
 */
export const SHELL_ENV_VARS = [
    'PATH',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
] as const;

type ShellVar = (typeof SHELL_ENV_VARS)[number];

/** A profile that hangs (a prompt, a broken plugin) must not hold the app's start hostage. */
export const SHELL_ENV_TIMEOUT_MS = 5_000;

export interface ShellEnvOptions {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    spawn?: typeof nodeSpawn;
    timeoutMs?: number;
}

/** The shell's entries first, in its order, then whatever the current PATH had that the shell did not. */
export function mergePath(current: string | undefined, resolved: string): string {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const entry of [...resolved.split(':'), ...(current ?? '').split(':')]) {
        if (!entry || seen.has(entry)) continue;
        seen.add(entry);
        merged.push(entry);
    }
    return merged.join(':');
}

/**
 * Pull the values out of whatever the profile printed around them (banners, warnings, prompts). The
 * marker is the separator as well as the fence, so no escape has to survive seven different shells;
 * a variable the shell has nothing for comes back as an empty field and is dropped.
 */
export function extractEnv(output: string): Partial<Record<ShellVar, string>> | null {
    const start = output.indexOf(MARKER);
    const end = output.lastIndexOf(MARKER);
    if (start < 0 || end <= start) return null;
    const values = output.slice(start + MARKER.length, end).split(MARKER);
    if (values.length !== SHELL_ENV_VARS.length) return null;
    const learned: Partial<Record<ShellVar, string>> = {};
    SHELL_ENV_VARS.forEach((name, index) => {
        const value = values[index];
        if (value) learned[name] = value;
    });
    return learned;
}

/**
 * What the user's interactive login shell ends up with, or null when it cannot be learned (Windows,
 * no shell, a shell that fails or hangs). Never throws: this is a best-effort improvement on the
 * inherited environment, and the inherited one is still a working fallback.
 */
export function loginShellEnv(options: ShellEnvOptions = {}): Promise<Partial<Record<ShellVar, string>> | null> {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const spawn = options.spawn ?? nodeSpawn;
    const timeoutMs = options.timeoutMs ?? SHELL_ENV_TIMEOUT_MS;
    if (platform === 'win32') return Promise.resolve(null);
    const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const format = `${MARKER}${SHELL_ENV_VARS.map(() => '%s').join(MARKER)}${MARKER}`;
    const script = `printf '${format}' ${SHELL_ENV_VARS.map((name) => `"$${name}"`).join(' ')}`;

    return new Promise((resolve) => {
        let output = '';
        let settled = false;
        const finish = (value: Partial<Record<ShellVar, string>> | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        let child: ReturnType<typeof nodeSpawn>;
        try {
            child = spawn(shell, ['-ilc', script], { env, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
            resolve(null);
            return;
        }
        const timer = setTimeout(() => {
            child.kill();
            finish(null);
        }, timeoutMs);
        child.stdout?.on('data', (chunk: Buffer | string) => {
            output += String(chunk);
        });
        child.on('error', () => finish(null));
        child.on('close', () => finish(extractEnv(output)));
    });
}

/**
 * Take what the login shell knows that this process does not: the PATH, merged so nothing inherited
 * is lost, and any proxy variable the process was started without. A variable the launch environment
 * already carries is left alone, since starting the app from a terminal that sets one is the more
 * specific answer. Returns the names actually adopted.
 */
export async function adoptLoginShellEnv(options: ShellEnvOptions = {}): Promise<string[]> {
    const env = options.env ?? process.env;
    const learned = await loginShellEnv({ ...options, env });
    if (!learned) return [];
    const adopted: string[] = [];
    if (learned.PATH) {
        const merged = mergePath(env.PATH, learned.PATH);
        if (merged !== env.PATH) {
            env.PATH = merged;
            adopted.push('PATH');
        }
    }
    for (const name of SHELL_ENV_VARS) {
        if (name === 'PATH' || !learned[name] || env[name]) continue;
        env[name] = learned[name];
        adopted.push(name);
    }
    return adopted;
}
