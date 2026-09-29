import type { QueryKey } from '@tanstack/react-query';
import { useIpcMutation, useIpcQuery } from './query';

/**
 * The configured chart sources. These are facts about this install rather than about the cluster,
 * so every write disturbs the list itself and the charts their indexes hold, and nothing
 * cluster-scoped.
 */

const listKey: () => QueryKey[] = () => [['chartRepositories.list'], ['charts.list']];

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
