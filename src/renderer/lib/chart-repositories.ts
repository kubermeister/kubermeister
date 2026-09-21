import type { QueryKey } from '@tanstack/react-query';
import { useIpcMutation, useIpcQuery } from './query';

/**
 * The configured chart sources. These are facts about this install rather than about the cluster,
 * so every write disturbs exactly one query — the list itself — and nothing cluster-scoped.
 */

const listKey: () => QueryKey[] = () => [['chartRepositories.list']];

export function useChartRepositories() {
    return useIpcQuery('chartRepositories.list', {});
}

export function useAddChartRepository() {
    return useIpcMutation('chartRepositories.add', { invalidates: listKey });
}

export function useRefreshChartRepository() {
    return useIpcMutation('chartRepositories.refresh', { invalidates: listKey });
}

export function useRemoveChartRepository() {
    return useIpcMutation('chartRepositories.remove', { invalidates: listKey });
}
