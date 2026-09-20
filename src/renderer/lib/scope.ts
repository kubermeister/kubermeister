import { type AnyRouter, useRouter } from '@tanstack/react-router';
import { useCallback } from 'react';
import { invoke } from './ipc';
import { listPathForSubPage } from './nav';
import { invalidateClusterQueries, queryClient, useIpcQuery } from './query';
import { stopAllForwards } from './port-forwards';
import { recheckConnection } from './settings';

/**
 * Switch kube-context and forget everything read from the previous one. Open forwards go with it:
 * main ends their streams anyway, and one left behind names a pod of the cluster being left. A
 * shell needs no such sweep — it lives on its pod's page, which is closed before the switch.
 */
export async function switchContext(name: string): Promise<void> {
    stopAllForwards();
    await invoke('context.set', { name });
    // The startup report speaks of the current context, so a switch reruns it: the top bar's
    // connection notice appears or clears with the context it now describes.
    await recheckConnection(queryClient);
}

/**
 * A detail page names one object of the scope being left, so it is closed first, back to its list:
 * keeping it open would show the same-named object of the new scope under the old page's live tabs.
 * A list page stays where it is and simply reloads under the new scope.
 */
async function closeDetail(router: AnyRouter): Promise<void> {
    const listPath = listPathForSubPage(router.state.location.pathname);
    if (listPath) await router.navigate({ to: listPath });
}

/** Switch context from a screen, closing an open detail page first; main ends its streams in any case. */
export function useSwitchContext(): (name: string) => Promise<void> {
    const router = useRouter();
    return useCallback(
        async (name: string) => {
            await closeDetail(router);
            await switchContext(name);
        },
        [router],
    );
}

/**
 * Scope namespaced reads to one namespace, or all with `null`, and start over. The reset happens the
 * moment main has switched: it covers `namespace.active` too, and waiting on that read first would
 * hold every list on the old rows until it had come back.
 */
export async function selectNamespace(namespace: string | null): Promise<void> {
    await invoke('namespace.set', { namespace });
    await invalidateClusterQueries();
}

/** Select a namespace from a screen, closing an open detail page first: its object lives in the namespace being left. */
export function useSelectNamespace(): (namespace: string | null) => Promise<void> {
    const router = useRouter();
    return useCallback(
        async (namespace: string | null) => {
            await closeDetail(router);
            await selectNamespace(namespace);
        },
        [router],
    );
}

/**
 * The active context and namespace, for anything that must reset when either changes. `namespace`
 * is undefined both while loading and under "All namespaces": it is a namespace name or nothing,
 * never a label, so it can be handed to a cluster call as it is.
 */
export function useScope(): { context: string | undefined; namespace: string | undefined; allNamespaces: boolean } {
    const context = useIpcQuery('context.current', {});
    const namespace = useIpcQuery('namespace.active', {});
    return {
        context: context.data?.name,
        namespace: namespace.data?.name ?? undefined,
        allNamespaces: namespace.data !== undefined && namespace.data?.name === null,
    };
}
