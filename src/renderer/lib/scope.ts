import { type AnyRouter, useRouter } from '@tanstack/react-router';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { invoke } from './ipc';
import { describeError } from './k8s-error';
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
 * A list page stays where it is and simply reloads under the new scope. False when the page refused
 * to close (an unsaved edit the reader kept), and the switch is then cancelled.
 */
async function closeDetail(router: AnyRouter): Promise<boolean> {
    const listPath = listPathForSubPage(router.state.location.pathname);
    if (!listPath) return true;
    if (await isBlocked(router, listPath)) return false;
    await router.navigate({ to: listPath, ignoreBlocker: true });
    return true;
}

/**
 * Ask the page's blockers first rather than letting the navigation meet them: the router leaves a
 * blocked navigation's promise pending until some later navigation settles it, which would run the
 * switch then, under whatever page is open by that time.
 */
async function isBlocked(router: AnyRouter, to: string): Promise<boolean> {
    const { history } = router;
    const next = router.buildLocation({ to });
    const nextLocation = {
        href: next.href,
        pathname: next.pathname,
        search: next.searchStr,
        hash: next.hash,
        state: history.location.state,
    };
    for (const blocker of history._getBlockers()) {
        if (await blocker.blockerFn({ currentLocation: history.location, nextLocation, action: 'PUSH' })) return true;
    }
    return false;
}

/** A switch is started from a menu that has already closed, so a refusal has nowhere else to be said. */
function reportFailure(title: string, error: unknown): void {
    toast.error(title, { description: describeError(error).detail });
}

/**
 * Switch context from a screen, closing an open detail page first; main ends its streams in any case.
 * Resolves false when the page refused to close or the switch failed, which it reports itself.
 */
export function useSwitchContext(): (name: string) => Promise<boolean> {
    const router = useRouter();
    return useCallback(
        async (name: string) => {
            if (!(await closeDetail(router))) return false;
            try {
                await switchContext(name);
            } catch (error) {
                reportFailure(`Could not switch to “${name}”`, error);
                return false;
            }
            return true;
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

/**
 * Select a namespace from a screen, closing an open detail page first: its object lives in the
 * namespace being left. Resolves false when the page refused to close or the switch failed, which it
 * reports itself.
 */
export function useSelectNamespace(): (namespace: string | null) => Promise<boolean> {
    const router = useRouter();
    return useCallback(
        async (namespace: string | null) => {
            if (!(await closeDetail(router))) return false;
            try {
                await selectNamespace(namespace);
                return true;
            } catch (error) {
                reportFailure(
                    namespace === null
                        ? 'Could not select all namespaces'
                        : `Could not select namespace “${namespace}”`,
                    error,
                );
                return false;
            }
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
