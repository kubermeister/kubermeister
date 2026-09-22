import type { QueryClient } from '@tanstack/react-query';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { IpcInput } from '../../shared/ipc';
import type { KubeContext } from '../../shared/k8s/contexts';
import type { ManifestKind } from '../../shared/k8s/manifest';
import type { Kind } from '../../shared/k8s/registry';
import { mapWithConcurrency, type BulkDeleteResult, type SelectionTarget } from './selection';
import { invoke, IpcError } from './ipc';
import { describeError } from './k8s-error';
import { ipcQueryKey, useIpcMutation } from './query';

type WriteChannel =
    | 'resources.create'
    | 'resources.replace'
    | 'resources.delete'
    | 'resources.scale'
    | 'resources.restart'
    | 'deployments.rollback'
    | 'deployments.pause'
    | 'nodes.cordon'
    | 'releases.rollback'
    | 'releases.uninstall'
    | 'pods.evict'
    | 'jobs.retry'
    | 'cronJobs.trigger'
    | 'cronJobs.suspend'
    | 'autoscalers.update';

/** What a screen passes to a write: the input minus the context stamp, which is added here. */
export type WriteVariables<C extends WriteChannel> = Omit<IpcInput<C>, 'context'>;

/**
 * The context the renderer believes it is on, from the cache the top bar renders from. Every write
 * carries it and main refuses a write whose stamp does not match the context it is really on, so a
 * screen still showing the previous cluster's rows can never act on the new one.
 */
export async function activeContextName(client: QueryClient, op: string): Promise<string> {
    const key = ipcQueryKey('context.current', {});
    const cached = client.getQueryData<KubeContext | null>(key);
    const context =
        cached ?? (await client.fetchQuery({ queryKey: key, queryFn: () => invoke('context.current', {}) }));
    if (!context) throw new IpcError({ kind: 'invalid', detail: 'No context is active.', op });
    return context.name;
}

async function stamp<C extends WriteChannel>(
    channel: C,
    variables: WriteVariables<C>,
    client: QueryClient,
): Promise<IpcInput<C>> {
    return { ...variables, context: await activeContextName(client, channel) } as IpcInput<C>;
}

/**
 * Which queries a write invalidates: the kind's own list and reads, plus the object's events. Keys
 * are matched by prefix, so naming the channel is enough to catch every input shape of it.
 */
function resourceKeys(kind: ManifestKind, name: string, namespace?: string) {
    return [
        ['resources.list'],
        ['resources.get'],
        ['resources.getYaml', { kind, name, namespace }],
        ['events.forObject'],
        ['metrics.alerts'],
    ];
}

export function useCreateResource() {
    return useIpcMutation<'resources.create', WriteVariables<'resources.create'>>('resources.create', {
        prepare: (variables, client) => stamp('resources.create', variables, client),
        invalidates: () => [['resources.list'], ['metrics.alerts']],
    });
}

export function useReplaceResource() {
    return useIpcMutation<'resources.replace', WriteVariables<'resources.replace'>>('resources.replace', {
        prepare: (variables, client) => stamp('resources.replace', variables, client),
        invalidates: (_input, data) => resourceKeys(data.kind as ManifestKind, data.name, data.namespace),
    });
}

export function useDeleteResource() {
    return useIpcMutation<'resources.delete', WriteVariables<'resources.delete'>>('resources.delete', {
        prepare: (variables, client) => stamp('resources.delete', variables, client),
        invalidates: (input) => resourceKeys(input.kind, input.name, input.namespace),
    });
}

export function useScaleResource() {
    return useIpcMutation<'resources.scale', WriteVariables<'resources.scale'>>('resources.scale', {
        prepare: (variables, client) => stamp('resources.scale', variables, client),
        invalidates: (input) => resourceKeys(input.kind as Kind, input.name, input.namespace),
    });
}

/**
 * Restart a workload. The rolled pods appear and disappear on their own, so beyond the kind's own
 * screens this refreshes nothing: the pod list is live through its watch.
 */
export function useRestartResource() {
    return useIpcMutation<'resources.restart', WriteVariables<'resources.restart'>>('resources.restart', {
        prepare: (variables, client) => stamp('resources.restart', variables, client),
        invalidates: (input) => resourceKeys(input.kind, input.name, input.namespace),
    });
}

/** Which queries a Deployment write disturbs: its own screens plus the rollout tabs beside them. */
function deploymentKeys(name: string, namespace: string) {
    return [
        ...resourceKeys('Deployment', name, namespace),
        ['deployments.rollouts'],
        ['deployments.replicaSets'],
        ['deployments.rolloutStatus'],
    ];
}

/** Roll a Deployment back to one of its own revisions. */
export function useRollbackDeployment() {
    return useIpcMutation<'deployments.rollback', WriteVariables<'deployments.rollback'>>('deployments.rollback', {
        prepare: (variables, client) => stamp('deployments.rollback', variables, client),
        invalidates: (input) => deploymentKeys(input.name, input.namespace),
    });
}

/** Hold a rollout where it stands, or let it continue. */
export function usePauseDeployment() {
    return useIpcMutation<'deployments.pause', WriteVariables<'deployments.pause'>>('deployments.pause', {
        prepare: (variables, client) => stamp('deployments.pause', variables, client),
        invalidates: (input) => deploymentKeys(input.name, input.namespace),
    });
}

/** Cordon or uncordon a node; the node screens and the alerts that count schedulable nodes follow. */
export function useCordonNode() {
    return useIpcMutation<'nodes.cordon', WriteVariables<'nodes.cordon'>>('nodes.cordon', {
        prepare: (variables, client) => stamp('nodes.cordon', variables, client),
        invalidates: () => [['nodes.list'], ['nodes.get'], ['metrics.alerts'], ['nodes.drainPlan']],
    });
}

/** Which queries a release write disturbs: the release screens plus the objects the chart owns. */
function releaseKeys() {
    return [
        ['releases.list'],
        ['releases.get'],
        ['releases.revisions'],
        ['helmCharts.list'],
        ['resources.list'],
        ['resources.get'],
        ['metrics.alerts'],
    ];
}

/** Roll a release back to one of its own revisions. */
export function useRollbackRelease() {
    return useIpcMutation<'releases.rollback', WriteVariables<'releases.rollback'>>('releases.rollback', {
        prepare: (variables, client) => stamp('releases.rollback', variables, client),
        invalidates: releaseKeys,
    });
}

/** Uninstall a release, with or without keeping its history. */
export function useUninstallRelease() {
    return useIpcMutation<'releases.uninstall', WriteVariables<'releases.uninstall'>>('releases.uninstall', {
        prepare: (variables, client) => stamp('releases.uninstall', variables, client),
        invalidates: releaseKeys,
    });
}

/** Evict one pod: the same screens a delete disturbs, since the pod goes either way. */
export function useEvictPod() {
    return useIpcMutation<'pods.evict', WriteVariables<'pods.evict'>>('pods.evict', {
        prepare: (variables, client) => stamp('pods.evict', variables, client),
        invalidates: (input) => resourceKeys('Pod', input.name, input.namespace),
    });
}

/** Run a job again; its pods are replaced, so the pod screens follow it. */
export function useRetryJob() {
    return useIpcMutation<'jobs.retry', WriteVariables<'jobs.retry'>>('jobs.retry', {
        prepare: (variables, client) => stamp('jobs.retry', variables, client),
        invalidates: (input) => [...resourceKeys('Job', input.name, input.namespace), ['workloads.pods']],
    });
}

/** Run a cron job now: a new job appears, which the job screens and the cron job's own pods show. */
export function useTriggerCronJob() {
    return useIpcMutation<'cronJobs.trigger', WriteVariables<'cronJobs.trigger'>>('cronJobs.trigger', {
        prepare: (variables, client) => stamp('cronJobs.trigger', variables, client),
        invalidates: (input) => [...resourceKeys('CronJob', input.name, input.namespace), ['workloads.pods']],
    });
}

/** Hold or resume a cron job's schedule. */
export function useSuspendCronJob() {
    return useIpcMutation<'cronJobs.suspend', WriteVariables<'cronJobs.suspend'>>('cronJobs.suspend', {
        prepare: (variables, client) => stamp('cronJobs.suspend', variables, client),
        invalidates: (input) => resourceKeys('CronJob', input.name, input.namespace),
    });
}

/** Adjust an autoscaler's bounds; its own screens and the workload it scales both follow. */
export function useUpdateAutoscaler() {
    return useIpcMutation<'autoscalers.update', WriteVariables<'autoscalers.update'>>('autoscalers.update', {
        prepare: (variables, client) => stamp('autoscalers.update', variables, client),
        invalidates: (input) => resourceKeys('HorizontalPodAutoscaler', input.name, input.namespace),
    });
}

/** How many deletes run at once: enough to be quick, few enough not to flood the API server. */
const BULK_DELETE_CONCURRENCY = 4;

/**
 * Delete several objects of one kind. Each is deleted on its own and a failure does not stop the
 * rest, so the caller can report exactly what went and what did not. The context is read once for
 * the whole batch, so every delete in it is aimed at the same cluster.
 */
export function useBulkDeleteResources() {
    const client = useQueryClient();
    return useMutation<BulkDeleteResult, Error, { kind: ManifestKind; targets: SelectionTarget[] }>({
        mutationFn: async ({ kind, targets }) => {
            const context = await activeContextName(client, 'resources.delete');
            const settled = await mapWithConcurrency(targets, BULK_DELETE_CONCURRENCY, async (target) => {
                try {
                    await invoke('resources.delete', { kind, name: target.name, namespace: target.namespace, context });
                    return { target, message: null };
                } catch (error) {
                    return { target, message: describeError(error).detail };
                }
            });
            return {
                deleted: settled.filter((one) => one.message === null).map((one) => one.target),
                failed: settled
                    .filter((one): one is { target: SelectionTarget; message: string } => one.message !== null)
                    .map((one) => ({ ...one.target, message: one.message })),
            };
        },
        onSuccess: async () => {
            await Promise.all(
                [['resources.list'], ['resources.get'], ['metrics.alerts']].map((queryKey) =>
                    client.invalidateQueries({ queryKey }),
                ),
            );
        },
    });
}
