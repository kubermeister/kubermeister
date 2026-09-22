import type { KubeConfig, User } from '@kubernetes/client-node';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { currentAbortSignal } from './abort.js';

/**
 * A credential plugin (`aws eks get-token`, `gke-gcloud-auth-plugin`, `kubelogin`, ...) that could
 * not produce a token. The client library rejects with the plugin's raw stderr, or with the spawn
 * error when the binary is missing; neither says which plugin it was or that authentication is
 * what failed, so the failure is wrapped here with the command and a sentence fit for the screen.
 */
export class ExecPluginError extends Error {
    readonly code = 'EXEC_PLUGIN';

    constructor(
        readonly command: string,
        readonly detail: string,
        cause: unknown,
    ) {
        super(detail, { cause });
        this.name = 'ExecPluginError';
    }
}

/** Longest stderr excerpt worth showing; the rest is the CLI's own stack or usage text. */
const MAX_REASON = 200;

function firstLine(text: string): string {
    const line = text
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0);
    if (!line) return '';
    return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
}

/** The sentence shown for a plugin failure: a missing binary and a failed run read differently. */
export function describeExecFailure(command: string, error: unknown): string {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') return `The credential plugin "${command}" was not found on the app's PATH.`;
    const reason = firstLine(error instanceof Error ? error.message : String(error ?? ''));
    return reason
        ? `The credential plugin "${command}" failed: ${reason}`
        : `The credential plugin "${command}" failed without a message.`;
}

interface Authenticator {
    isAuthProvider(user: User): boolean;
    applyAuthentication(user: User, opts: unknown): Promise<void>;
}

/** The library's own spawn seam: `ExecAuth.execFn` holds `child_process.spawn` and nothing else. */
type SpawnPlugin = (command: string, args?: readonly string[], options?: SpawnOptions) => ChildProcess;

interface Spawner {
    execFn?: SpawnPlugin;
}

/**
 * End a plugin process when the call that needed it gives up. The library waits for the process to
 * close and has nothing to tell it to stop, so a plugin blocked on a login in a browser outlives the
 * read that spawned it and every retry the screen makes adds another. The listener goes with the
 * process, so a plugin that answered in time leaves nothing attached to the signal.
 */
function killOnAbort(child: ChildProcess, signal: AbortSignal | undefined): void {
    if (!signal) return;
    if (signal.aborted) {
        child.kill();
        return;
    }
    const kill = () => child.kill();
    signal.addEventListener('abort', kill, { once: true });
    child.once('close', () => signal.removeEventListener('abort', kill));
}

/** The plugin command a user entry runs, in either of the two shapes the kubeconfig allows. */
export function execCommandOf(user: User | null | undefined): string | null {
    const exec = (user?.exec ?? user?.authProvider?.config?.exec) as { command?: unknown } | undefined;
    return typeof exec?.command === 'string' && exec.command ? exec.command : null;
}

const guarded = new WeakSet<KubeConfig>();

/**
 * Wrap the library's authenticators so a plugin failure surfaces as an {@link ExecPluginError} and
 * so the process a plugin runs in ends with the call that needed it. The authenticator list is per
 * KubeConfig, so every freshly loaded config is guarded once.
 */
export function guardCredentialPlugins(kc: KubeConfig): void {
    if (guarded.has(kc)) return;
    guarded.add(kc);
    const list = (kc as unknown as { authenticators?: unknown }).authenticators;
    if (!Array.isArray(list)) return;
    for (const auth of list as Authenticator[]) {
        const original = auth.applyAuthentication.bind(auth);
        auth.applyAuthentication = async (user, opts) => {
            try {
                await original(user, opts);
            } catch (error) {
                const command = execCommandOf(user);
                if (!command) throw error;
                throw new ExecPluginError(command, describeExecFailure(command, error), error);
            }
        };
        const spawner = auth as Spawner;
        const spawnPlugin = spawner.execFn?.bind(auth);
        if (!spawnPlugin) continue;
        spawner.execFn = (command, args, options) => {
            const child = spawnPlugin(command, args, options);
            killOnAbort(child, currentAbortSignal());
            return child;
        };
    }
}
