import {
    MutationCache,
    QueryClient,
    useMutation,
    useQuery,
    useQueryClient,
    type QueryFilters,
    type QueryKey,
    type UseQueryOptions,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import type { IpcChannel, IpcInput, IpcOutput } from '../../shared/ipc';
import { invoke } from './ipc';
import { describeError } from './k8s-error';

export const queryClient = new QueryClient({
    /*
     * Every rejected write reports itself here, so a failed delete or scale can never pass
     * unnoticed and no hook needs its own error plumbing. Reads are not funnelled here: list and
     * detail screens render their own error states.
     */
    mutationCache: new MutationCache({
        onError: (error) => {
            const { title, detail } = describeError(error);
            toast.error(title, { description: detail });
        },
    }),
    defaultOptions: {
        queries: {
            retry: false,
            refetchOnWindowFocus: false,
            // Absorbs list-to-detail-and-back navigation without refetching. Keys carry no scope, so
            // a context or namespace switch resets cluster queries outright (see
            // `invalidateClusterQueries`) rather than trusting staleness to hide the old scope.
            staleTime: 5_000,
        },
    },
});

/** Query key for a channel and its input; the same shape everywhere so invalidation is by prefix. */
export function ipcQueryKey<C extends IpcChannel>(channel: C, input: IpcInput<C>): readonly [C, IpcInput<C>] {
    return [channel, input] as const;
}

/** A TanStack Query over one IPC channel, typed from the shared contract. */
export function useIpcQuery<C extends IpcChannel, TData = IpcOutput<C>>(
    channel: C,
    input: IpcInput<C>,
    options?: Omit<UseQueryOptions<IpcOutput<C>, Error, TData>, 'queryKey' | 'queryFn'>,
) {
    return useQuery<IpcOutput<C>, Error, TData>({
        queryKey: ipcQueryKey(channel, input),
        queryFn: () => invoke(channel, input),
        ...options,
    });
}

/** Channels whose data does not come from the cluster, so a scope switch leaves them in place. */
const APP_LEVEL_CHANNELS = new Set<string>([
    'startupChecks',
    'contexts.list',
    'settings.get',
    'settingsFile.status',
    // Chart sources belong to this install, not to the cluster it happens to be pointed at.
    'chartRepositories.list',
]);

function isClusterQuery(queryKey: QueryKey): boolean {
    const channel = String(queryKey[0]);
    return !channel.startsWith('app.') && !channel.startsWith('update.') && !APP_LEVEL_CHANNELS.has(channel);
}

const CLUSTER_QUERIES: QueryFilters = { predicate: ({ queryKey }) => isClusterQuery(queryKey) };

/**
 * Forget every cluster-scoped query after a context or namespace switch. Keys do not carry the
 * scope, so an invalidation alone would keep serving the previous scope's rows until the refetch
 * landed, and a delete or scale clicked in that window would act on the same-named object in the
 * new scope. A reset drops the data and puts every mounted screen back into its loading state.
 * The contexts list only changes its `current` flag, so it is refetched in place.
 */
export async function invalidateClusterQueries(): Promise<void> {
    await Promise.all([
        queryClient.resetQueries(CLUSTER_QUERIES),
        queryClient.invalidateQueries({ queryKey: ['contexts.list'] }),
    ]);
}

/**
 * Mark what a write changed as out of date. A read already in flight went out before the write
 * landed, so it is cancelled first: left alone it would settle as fresh with the old answer, and a
 * screen mounting meanwhile joins that read instead of starting its own. On an unmounted list that
 * is a deleted row back on screen with nothing left to remove it.
 */
export async function refreshAfterWrite(client: QueryClient, keys: QueryKey[]): Promise<void> {
    await Promise.all(
        keys.map(async (queryKey) => {
            await client.cancelQueries({ queryKey });
            await client.invalidateQueries({ queryKey });
        }),
    );
}

export interface IpcMutationOptions<C extends IpcChannel, TVariables> {
    /** Query keys to refetch once the write succeeds; name only the domains the write touches. */
    invalidates?: (input: IpcInput<C>, data: IpcOutput<C>) => QueryKey[];
    /** Turn what the caller passes into the channel's input, for fields the caller should not supply itself. */
    prepare?: (variables: TVariables, client: QueryClient) => Promise<IpcInput<C>>;
}

/**
 * The hook every cluster write goes through. There is no optimistic update: the cluster is
 * authoritative and takes its time (a deleted object lingers while it terminates), so the write
 * awaits invalidation of the screens it affects and the caller drives its button state from
 * `isPending`. Blanket invalidation stays reserved for a context or namespace switch.
 */
export function useIpcMutation<C extends IpcChannel, TVariables = IpcInput<C>>(
    channel: C,
    options: IpcMutationOptions<C, TVariables> = {},
) {
    const client = useQueryClient();
    return useMutation<IpcOutput<C>, Error, TVariables, IpcInput<C>>({
        mutationFn: async (variables) => {
            const input = options.prepare
                ? await options.prepare(variables, client)
                : (variables as unknown as IpcInput<C>);
            const data = await invoke(channel, input);
            await refreshAfterWrite(client, options.invalidates?.(input, data) ?? []);
            return data;
        },
    });
}
