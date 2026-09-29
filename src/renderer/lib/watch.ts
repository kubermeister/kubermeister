import { hashKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Kind } from '../../shared/k8s/registry';
import type { ResourceListOutput, RowOf } from '../../shared/k8s/resources';
import type { WatchEvent } from '../../shared/streams';
import { stream } from './ipc';
import { ipcQueryKey, useIpcQuery } from './query';

/**
 * Apply one watch event to a cached list. An `added` event for a row already present is a replace,
 * since a watch replays existing objects when it starts. The cache is left alone until the list
 * itself has loaded, so events never create a partial list; `useWatchedList` holds such events and
 * applies them once the list answers.
 */
export function applyWatchEvent(
    current: ResourceListOutput | undefined,
    event: WatchEvent,
): ResourceListOutput | undefined {
    if (!current || current.kind !== event.kind) return current;
    // Cluster-scoped rows carry no namespace, so the id is just `/name` for them.
    const id = (row: { namespace?: string; name: string }) => `${row.namespace ?? ''}/${row.name}`;
    const index = current.items.findIndex((row) => id(row) === id(event.item));
    const items = [...current.items];
    if (event.type === 'deleted') {
        if (index >= 0) items.splice(index, 1);
    } else if (index >= 0) {
        items[index] = event.item;
    } else {
        items.push(event.item);
    }
    return { ...current, items } as ResourceListOutput;
}

/**
 * A list kept live by a watch stream: the initial rows come from `resources.list`, then every
 * event is applied into the same query cache entry, so consumers see one continuously updated
 * array. The stream restarts when the kind, the explicit namespace, the active namespace or the
 * context changes. On a stream error the list is refetched and the watch reconnects on its own.
 *
 * The list is a separate read from the informer, so an event can arrive while it is in flight and
 * describe a change its answer predates. Every event heard while the list is fetching is kept and
 * applied again over the answer, which is the older of the two; otherwise a pod deleted in that
 * window would keep its row for good.
 */
export function useWatchedList<K extends Kind>(kind: K, namespace?: string) {
    const queryClient = useQueryClient();
    const [live, setLive] = useState(false);
    const activeNamespace = useIpcQuery('namespace.active', {});
    const context = useIpcQuery('context.current', {});
    // The watch is pinned to the namespace and context it started with, so it waits until both are
    // known and restarts when either changes.
    const ready = activeNamespace.data !== undefined && context.data !== undefined;
    const scope = `${context.data?.name ?? ''}|${activeNamespace.data?.name ?? ''}`;

    const query = useIpcQuery(
        'resources.list',
        { kind, namespace },
        {
            select: (output) => output.items as Array<RowOf<K>>,
            refetchInterval: false,
        },
    );

    useEffect(() => {
        if (!ready) return;
        const key = ipcQueryKey('resources.list', { kind, namespace });
        const hash = hashKey(key);
        let heardDuringFetch: WatchEvent[] = [];
        const unsubscribe = queryClient.getQueryCache().subscribe((cacheEvent) => {
            if (cacheEvent.type !== 'updated' || cacheEvent.query.queryHash !== hash) return;
            const { action } = cacheEvent;
            // `manual` is a `setQueryData`, which is this hook applying events rather than an answer.
            if (action.type === 'success' && !action.manual) {
                const replay = heardDuringFetch;
                heardDuringFetch = [];
                if (replay.length === 0) return;
                queryClient.setQueryData<ResourceListOutput>(key, (current) => replay.reduce(applyWatchEvent, current));
            } else if (action.type === 'error') {
                // The cache kept the rows these events were already applied to.
                heardDuringFetch = [];
            }
        });
        const handle = stream('resources.watch', { kind, namespace }, (message) => {
            if (message.type === 'data') {
                setLive(true);
                if (queryClient.getQueryState(key)?.fetchStatus !== 'idle') heardDuringFetch.push(message.data);
                queryClient.setQueryData<ResourceListOutput>(key, (current) => applyWatchEvent(current, message.data));
            } else {
                setLive(false);
                if (message.type === 'error') void queryClient.invalidateQueries({ queryKey: key });
            }
        });
        return () => {
            setLive(false);
            handle.stop();
            unsubscribe();
        };
    }, [kind, namespace, scope, ready, queryClient]);

    return { ...query, live };
}
