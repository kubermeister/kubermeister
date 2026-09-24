import type { KubeConfig } from '@kubernetes/client-node';
import { normalizeServer } from '../../shared/deep-link.js';
import type { KubeContext } from '../../shared/k8s/contexts.js';
import { updateSettings } from '../settings/store.js';
import { contextProblem, getActiveNamespace, invalidateApis, kubeConfig, setActiveNamespace } from './client.js';
import { resetHistory } from './sampler.js';

function toKubeContext(
    name: string,
    cluster: string,
    server: string | undefined,
    user: string,
    namespace: string | undefined,
    current: string,
    problem: string | null,
): KubeContext {
    return {
        name,
        cluster,
        ...(server ? { server } : {}),
        user,
        namespace: namespace || undefined,
        current: name === current,
        ...(problem ? { problem } : {}),
    };
}

/** The API server a link names this context's cluster by, read from the kubeconfig alone. */
function serverOf(kc: KubeConfig, cluster: string): string | undefined {
    const server = kc.getCluster(cluster)?.server;
    return server ? normalizeServer(server) : undefined;
}

export function listContexts(): KubeContext[] {
    const kc = kubeConfig();
    const current = kc.getCurrentContext();
    return kc
        .getContexts()
        .map((ctx) =>
            toKubeContext(
                ctx.name,
                ctx.cluster,
                serverOf(kc, ctx.cluster),
                ctx.user,
                ctx.namespace,
                current,
                contextProblem(kc, ctx.name),
            ),
        );
}

export function getCurrentContext(): KubeContext | null {
    const kc = kubeConfig();
    const current = kc.getCurrentContext();
    if (!current) return null;
    const ctx = kc.getContextObject(current);
    if (!ctx) return null;
    return toKubeContext(
        ctx.name,
        ctx.cluster,
        serverOf(kc, ctx.cluster),
        ctx.user,
        ctx.namespace,
        current,
        contextProblem(kc, current),
    );
}

/**
 * Switch the context the app reads from. Only in-memory state changes; the kubeconfig file is
 * never written. API clients are dropped so later reads use the new context, the active namespace
 * resets to the new context's default, and the selection is remembered in the app's own settings.
 */
export function setContext(name: string): KubeContext {
    const kc = kubeConfig();
    const ctx = kc.getContextObject(name);
    if (!ctx) throw new Error(`Unknown context: ${name}`);
    kc.setCurrentContext(name);
    invalidateApis();
    // Sampled usage belongs to the previous cluster.
    resetHistory();
    setActiveNamespace(ctx.namespace ?? null);
    updateSettings({ session: { lastContext: name, lastNamespace: ctx.namespace ?? null } });
    return toKubeContext(
        ctx.name,
        ctx.cluster,
        serverOf(kc, ctx.cluster),
        ctx.user,
        ctx.namespace,
        name,
        contextProblem(kc, name),
    );
}

export function setNamespace(namespace: string | null): { namespace: string | null } {
    setActiveNamespace(namespace);
    updateSettings({ session: { lastNamespace: namespace } });
    return { namespace: getActiveNamespace() };
}
