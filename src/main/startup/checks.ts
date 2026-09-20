import type { StartupCheck, StartupReport } from '../../shared/ipc.js';
import { apis, currentContextProblem, kubeconfigError } from '../k8s/client.js';
import { getCurrentContext } from '../k8s/context.js';
import { withK8s } from '../k8s/errors.js';

/** A probe against an unreachable API server must not hang the startup screen. */
const CLUSTER_PROBE_TIMEOUT_MS = 5_000;

/**
 * The kubeconfig the app will load must exist and parse. Unlike an offline cluster, nothing works
 * until this is fixed, so it is a hard error with a pointer to the fix. A settings override that
 * fails offers a reset to the default; a broken default has to be fixed on disk.
 */
export function checkKubeconfig(): StartupCheck {
    const base = { id: 'kubeconfig', label: 'Kubeconfig file' } as const;
    const problem = kubeconfigError();
    if (problem) {
        return {
            ...base,
            status: 'error',
            detail: problem,
            hint: problem.startsWith('The default')
                ? 'Fix your default kubeconfig ($KUBECONFIG or ~/.kube/config).'
                : 'Fix or clear the kubeconfig path in Settings.',
        };
    }
    return { ...base, status: 'ok', detail: 'Kubeconfig loaded' };
}

/**
 * The current context must name a cluster and a user the kubeconfig defines. A file that loads can
 * still carry a context whose entries were dropped or never existed; every call on it fails, so it
 * is an error, but one the top bar can fix by switching context, which is what the hint says. No
 * current context at all is only a warning: the app opens and the selector is where one is chosen.
 */
export function checkContext(): StartupCheck {
    const base = { id: 'context', label: 'Current context' } as const;
    let problem: string | null;
    try {
        const context = getCurrentContext();
        problem = currentContextProblem();
        if (!problem) {
            if (context) return { ...base, status: 'ok', detail: `Using ${context.name}` };
            return {
                ...base,
                status: 'warning',
                detail: 'No current context is set in your kubeconfig.',
                hint: 'Select a context once the app is open.',
            };
        }
    } catch (error) {
        problem = error instanceof Error ? error.message.replace(/^\[\w+\] /, '') : String(error);
    }
    return {
        ...base,
        status: 'error',
        detail: problem,
        hint: 'Switch to another context in the top bar, or fix the entry in the kubeconfig.',
    };
}

/**
 * Probe the active context. Reachability problems are a warning, never an error: the current
 * context may legitimately be offline and the user can switch contexts once inside.
 */
export async function checkCluster(): Promise<StartupCheck> {
    const base = { id: 'cluster', label: 'Cluster connection' } as const;
    try {
        const context = getCurrentContext();
        if (!context) {
            return {
                ...base,
                status: 'warning',
                detail: 'No current context is set in your kubeconfig.',
                hint: 'Select a context once the app is open.',
            };
        }
        const info = await withK8s('startup.version', () => apis().version.getCode(), CLUSTER_PROBE_TIMEOUT_MS);
        return { ...base, status: 'ok', detail: `Connected to ${context.name} (Kubernetes ${info.gitVersion})` };
    } catch (error) {
        return {
            ...base,
            status: 'warning',
            detail: error instanceof Error ? error.message.replace(/^\[\w+\] /, '') : String(error),
            hint: 'The app opens anyway; switch to a reachable context or fix the connection.',
        };
    }
}

function skipped(id: 'context' | 'cluster', reason: string): StartupCheck {
    const label = id === 'context' ? 'Current context' : 'Cluster connection';
    return { id, label, status: 'warning', detail: `Skipped: ${reason}` };
}

/**
 * Run every check in dependency order; the report is ok when nothing is an error. A check whose
 * precondition failed is reported as skipped rather than run into the same failure again.
 */
export async function runStartupChecks(): Promise<StartupReport> {
    const kubeconfig = checkKubeconfig();
    const context =
        kubeconfig.status === 'error' ? skipped('context', 'the kubeconfig could not be loaded.') : checkContext();
    const cluster =
        kubeconfig.status === 'error'
            ? skipped('cluster', 'the kubeconfig could not be loaded.')
            : context.status !== 'ok'
              ? skipped('cluster', 'there is no usable current context.')
              : await checkCluster();
    const checks = [kubeconfig, context, cluster];
    return { checks, ok: checks.every((check) => check.status !== 'error') };
}
