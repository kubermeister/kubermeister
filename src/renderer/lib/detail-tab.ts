import { useSyncExternalStore } from 'react';

/**
 * The label of the tab a detail screen shows, for the breadcrumb. The URL carries only the tab's id
 * and the top bar sits outside the route that knows the rail, so the screen publishes it here. It
 * is keyed by the path it was published under, so a label never outlives its screen.
 */
interface PublishedTab {
    pathname: string;
    label: string;
}

let published: PublishedTab | null = null;
const listeners = new Set<() => void>();

function emit(next: PublishedTab | null) {
    published = next;
    for (const listener of listeners) listener();
}

/**
 * Publish the label for `pathname`, or nothing when the path names no tab. Returns the cleanup
 * that withdraws it, for an effect to hand back.
 */
export function publishDetailTab(pathname: string, label: string | undefined): () => void {
    const entry = label ? { pathname, label } : null;
    emit(entry);
    return () => {
        if (published === entry) emit(null);
    };
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The label published for `pathname`, if the screen on it names its tab in the path. */
export function useDetailTabLabel(pathname: string): string | undefined {
    const current = useSyncExternalStore(subscribe, () => published);
    return current?.pathname === pathname ? current.label : undefined;
}
