import type { CoreV1Event } from '@kubernetes/client-node';
import type { ClusterEvent, EventType, ObjectEventsInput } from '../../../shared/k8s/events.js';
import { isClusterScopedKindName } from '../../../shared/k8s/registry.js';
import { apis, isSafeSelectorValue, listItems, resolveObjectNamespace } from '../client.js';
import { withK8s } from '../errors.js';

/**
 * The most recent of the timestamps an event may carry, as ISO; undefined when it has none. An
 * event written through `events.k8s.io` keeps its first `eventTime` and no `lastTimestamp`, so a
 * repeating one says when it last happened only in `series.lastObservedTime`.
 */
export function eventTimestamp(event: CoreV1Event): string | undefined {
    const raw = event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp ?? event.metadata?.creationTimestamp;
    return isoOf(event.series?.lastObservedTime) ?? isoOf(raw);
}

function isoOf(raw: Date | string | undefined): string | undefined {
    if (!raw) return undefined;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** `HH:MM:SS` in the local zone, or a dash when the timestamp is missing or unparsable. */
export function clockTime(iso?: string): string {
    if (!iso) return '—';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '—' : date.toTimeString().slice(0, 8);
}

export function toClusterEvent(event: CoreV1Event): ClusterEvent {
    const involved = event.involvedObject;
    return {
        time: clockTime(eventTimestamp(event)),
        type: event.type === 'Warning' ? 'Warning' : ('Normal' satisfies EventType),
        reason: event.reason ?? '',
        object: involved?.kind ? `${involved.kind.toLowerCase()}/${involved.name ?? ''}` : '—',
        namespace: event.metadata?.namespace || undefined,
        message: event.message ?? '',
    };
}

/** Newest first; events without any timestamp sink to the end. */
export function sortedByTimeDesc(events: CoreV1Event[]): CoreV1Event[] {
    const at = (event: CoreV1Event) => {
        const iso = eventTimestamp(event);
        return iso ? new Date(iso).getTime() : 0;
    };
    return [...events].sort((a, b) => at(b) - at(a));
}

// Bounds the working set on an event-heavy cluster: the core API cannot order events by time, and
// events carry a short TTL, so this caps the fetch rather than guaranteeing the globally newest N.
const EVENT_LIST_LIMIT = 500;
export const RECENT_EVENTS = 20;

/** The newest events across all namespaces, for the cluster summary. Cluster-wide by design. */
export function listRecentEvents(): Promise<ClusterEvent[]> {
    return withK8s('events.recent', async () => {
        const result = await apis().core.listEventForAllNamespaces({ limit: EVENT_LIST_LIMIT });
        return sortedByTimeDesc(result.items).slice(0, RECENT_EVENTS).map(toClusterEvent);
    });
}

/** Every event in the explicit, active or all namespaces, newest first. */
export function listEvents(namespace?: string): Promise<ClusterEvent[]> {
    return withK8s('events.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().core.listNamespacedEvent({ namespace: ns, limit: EVENT_LIST_LIMIT }),
            () => apis().core.listEventForAllNamespaces({ limit: EVENT_LIST_LIMIT }),
        );
        return sortedByTimeDesc(items).map(toClusterEvent);
    });
}

/**
 * Events involving one object, newest first. Unsafe selector values yield no events rather than a
 * bad query. A cluster-scoped kind's events are searched across all namespaces; a namespaced kind
 * with no namespace to search yields none, since events of same-named objects elsewhere are not its.
 */
export function listEventsForObject({ kind, name, namespace }: ObjectEventsInput): Promise<ClusterEvent[]> {
    return withK8s('events.forObject', async () => {
        if (!isSafeSelectorValue(kind) || !isSafeSelectorValue(name)) return [];
        const fieldSelector = `involvedObject.kind=${kind},involvedObject.name=${name}`;
        const clusterScoped = isClusterScopedKindName(kind);
        const scope = clusterScoped ? undefined : (resolveObjectNamespace(namespace) ?? undefined);
        if (!clusterScoped && !scope) return [];
        const result = scope
            ? await apis().core.listNamespacedEvent({ namespace: scope, fieldSelector })
            : await apis().core.listEventForAllNamespaces({ fieldSelector });
        return sortedByTimeDesc(result.items).map(toClusterEvent);
    });
}
