import type { AnyRouter } from '@tanstack/react-router';
import { UNLINKABLE_TABS, type DeepLink } from '../../shared/deep-link';

/**
 * The route path a link may open, or `null` when no screen has it. Main has already refused
 * anything that is not a plain path; this is where it meets the route tree, which only the renderer
 * holds. A path naming a tab that acts on being opened, the Shell, opens the object's first tab
 * instead, since a click on a link is not a decision to exec into a pod.
 */
export function linkablePath(router: AnyRouter, path: string): string | null {
    const [, params, foundRoute] = router.getMatchedRoutes(path);
    // The router matches fuzzily, answering the deepest route a longer path starts with and the rest
    // under `**`; a link naming more than a screen has is not one of that screen's.
    if (!foundRoute || '**' in params) return null;
    const tab: string | undefined = params.tab;
    if (tab !== undefined && UNLINKABLE_TABS.has(tab)) return path.slice(0, path.lastIndexOf('/')) || '/';
    return path;
}

/** What opening a link comes to, decided before anything is shown or switched. */
export type LinkPlan =
    | { kind: 'refused'; message: string }
    | { kind: 'navigate'; path: string }
    | { kind: 'confirm'; from: string | undefined; server: string; candidates: string[]; path: string }
    | { kind: 'missingCluster'; server: string };

/** The part of a kubeconfig context the plan reads. */
interface LinkContext {
    name: string;
    server?: string;
    problem?: string;
}

/**
 * Decide what a link does. A link names the cluster by its API server, since a context is whatever
 * each kubeconfig calls it, and every context is matched on its own cluster entry's server, read from
 * the kubeconfig alone. It only ever navigates: straight away when the current context reaches that
 * cluster, only once the user has agreed to switch when other contexts do (every one is offered, since
 * two contexts on one cluster usually differ in who they act as), and not at all when none does. The
 * namespace in the path is the object's own, so the namespace selection is never part of the plan.
 */
export function planDeepLink(
    link: DeepLink,
    scope: { current: LinkContext | undefined; contexts: readonly LinkContext[] },
    resolvePath: (path: string) => string | null,
): LinkPlan {
    if (!link.ok) return { kind: 'refused', message: link.reason };
    const path = resolvePath(link.path);
    if (path === null)
        return { kind: 'refused', message: 'The link names a screen this version of Kubermeister does not have.' };
    if (scope.current?.server === link.server && !scope.current.problem) return { kind: 'navigate', path };
    const candidates = scope.contexts
        .filter((context) => context.server === link.server && !context.problem)
        .map((context) => context.name);
    if (candidates.length === 0) return { kind: 'missingCluster', server: link.server };
    return { kind: 'confirm', from: scope.current?.name, server: link.server, candidates, path };
}

/** The route path Copy link writes for the screen at `pathname`: a Shell tab is copied as the object's first tab. */
export function copyablePath(pathname: string, tab: string | undefined): string {
    if (tab === undefined || !UNLINKABLE_TABS.has(tab)) return pathname;
    return pathname.slice(0, pathname.lastIndexOf('/')) || '/';
}
