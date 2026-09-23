import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderInRouter } from './helpers';

const invoke = vi.fn();
const subscribe = vi.fn(() => () => {});
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    subscribe,
}));

const toasts = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', async () => ({
    ...(await vi.importActual<typeof import('sonner')>('sonner')),
    toast: toasts,
}));

const { EvictButton } = await import('@/components/pod/evict-button');
const { RetryJobButton, SuspendCronJobButton, TriggerCronJobButton } =
    await import('@/components/workload/job-actions');
const { DeleteResourceButton } = await import('@/components/templates/delete-resource-button');

const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'context.current': { name: 'alpha', cluster: 'a', user: 'u', current: true },
    'pods.evict': { kind: 'Pod', name: 'web-1', namespace: 'team-a' },
    'jobs.retry': { kind: 'Job', name: 'import', namespace: 'team-a' },
    'cronJobs.trigger': { kind: 'Job', name: 'nightly-2609161030', namespace: 'team-a' },
    'cronJobs.suspend': { kind: 'CronJob', name: 'nightly', namespace: 'team-a' },
    'resources.delete': { kind: 'Pod', name: 'web-1', namespace: 'team-a' },
    'autoscalers.update': { kind: 'HorizontalPodAutoscaler', name: 'web', namespace: 'team-a' },
};

beforeEach(() => {
    invoke.mockReset();
    toasts.success.mockReset();
    invoke.mockImplementation(async (channel: string) => data[channel]);
});

describe('evicting a pod', () => {
    it('says a budget may refuse it, then asks through the eviction channel', async () => {
        renderInRouter(<EvictButton name="web-1" namespace="team-a" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Evict' }));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('a disruption budget may refuse it');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Evict' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('pods.evict', {
                context: 'alpha',
                name: 'web-1',
                namespace: 'team-a',
            }),
        );
        expect(toasts.success).toHaveBeenCalledWith('Pod “web-1” evicted', expect.anything());
    });
});

describe('dismissing an action', () => {
    it('leaves the cluster alone when a dialog is cancelled', async () => {
        const { unmount } = renderInRouter(<EvictButton name="web-1" namespace="team-a" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Evict' }));
        await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
        unmount();

        renderInRouter(<RetryJobButton name="import" namespace="team-a" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Run again' }));
        await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
        expect(invoke).not.toHaveBeenCalledWith('pods.evict', expect.anything());
        expect(invoke).not.toHaveBeenCalledWith('jobs.retry', expect.anything());
    });

    it('says nothing succeeded when an eviction or a retry is refused', async () => {
        const { IpcError } = await import('@/lib/ipc');
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'pods.evict' || channel === 'jobs.retry' || channel === 'cronJobs.suspend') {
                throw new IpcError({ kind: 'forbidden', detail: 'no access', op: channel });
            }
            return data[channel];
        });
        const { unmount } = renderInRouter(<EvictButton name="web-1" namespace="team-a" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Evict' }));
        await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Evict' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('pods.evict', expect.anything()));
        unmount();

        const retry = renderInRouter(<RetryJobButton name="import" namespace="team-a" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Run again' }));
        await userEvent.click(
            within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Run again' }),
        );
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('jobs.retry', expect.anything()));
        retry.unmount();

        renderInRouter(<SuspendCronJobButton name="nightly" namespace="team-a" suspended={false} />);
        await userEvent.click(await screen.findByRole('button', { name: 'Suspend' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('cronJobs.suspend', expect.anything()));
        expect(toasts.success).not.toHaveBeenCalled();
    });
});

describe('deleting a pod without waiting', () => {
    it('offers the option only for pods, and sends a zero grace period when chosen', async () => {
        const { unmount } = renderInRouter(
            <DeleteResourceButton kind="Pod" name="web-1" namespace="team-a" backTo="/workloads/pods" />,
        );
        await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
        const dialog = await screen.findByRole('alertdialog');
        await userEvent.click(within(dialog).getByRole('switch', { name: /Delete without waiting/ }));
        await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('resources.delete', {
                context: 'alpha',
                kind: 'Pod',
                name: 'web-1',
                namespace: 'team-a',
                gracePeriodSeconds: 0,
            }),
        );
        unmount();

        // Anything else keeps the plain dialog: the grace period is its controller's business.
        renderInRouter(
            <DeleteResourceButton kind="ConfigMap" name="app" namespace="team-a" backTo="/workloads/configmaps" />,
        );
        await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
        expect(
            within(await screen.findByRole('alertdialog')).queryByRole('switch', { name: /without waiting/ }),
        ).not.toBeInTheDocument();
    });

    it('deletes normally when the option is left alone', async () => {
        renderInRouter(<DeleteResourceButton kind="Pod" name="web-1" namespace="team-a" backTo="/workloads/pods" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
        await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('resources.delete', {
                context: 'alpha',
                kind: 'Pod',
                name: 'web-1',
                namespace: 'team-a',
            }),
        );
    });
});

describe('job and cron job actions', () => {
    it('warns that running a job again replaces the previous run', async () => {
        renderInRouter(<RetryJobButton name="import" namespace="team-a" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Run again' }));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('deleted and submitted again');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Run again' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('jobs.retry', {
                context: 'alpha',
                name: 'import',
                namespace: 'team-a',
            }),
        );
        expect(toasts.success).toHaveBeenCalledWith('Job “import” started again');
    });

    it('runs a cron job now and names the job it made', async () => {
        renderInRouter(<TriggerCronJobButton name="nightly" namespace="team-a" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Run now' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('cronJobs.trigger', {
                context: 'alpha',
                name: 'nightly',
                namespace: 'team-a',
            }),
        );
        expect(toasts.success).toHaveBeenCalledWith('Job “nightly-2609161030” created', expect.anything());
    });

    it('suspends a running schedule and resumes a held one from the same control', async () => {
        const { unmount } = renderInRouter(
            <SuspendCronJobButton name="nightly" namespace="team-a" suspended={false} />,
        );
        await userEvent.click(await screen.findByRole('button', { name: 'Suspend' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('cronJobs.suspend', expect.objectContaining({ suspend: true })),
        );
        expect(toasts.success).toHaveBeenCalledWith('Schedule of “nightly” suspended');
        unmount();

        renderInRouter(<SuspendCronJobButton name="nightly" namespace="team-a" suspended />);
        await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('cronJobs.suspend', expect.objectContaining({ suspend: false })),
        );
        expect(toasts.success).toHaveBeenCalledWith('Schedule of “nightly” resumed');
    });

    it('claims nothing when the cluster refuses an action', async () => {
        const { IpcError } = await import('@/lib/ipc');
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'cronJobs.trigger') {
                throw new IpcError({ kind: 'forbidden', detail: 'no access', op: channel });
            }
            return data[channel];
        });
        renderInRouter(<TriggerCronJobButton name="nightly" namespace="team-a" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Run now' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('cronJobs.trigger', expect.anything()));
        expect(toasts.success).not.toHaveBeenCalled();
    });
});

describe('autoscaler bounds', () => {
    it('sends only the range when only the range changed, so the metrics are left as they are', async () => {
        const { AutoscalerBounds } = await import('@/components/workload/autoscaler-bounds');
        renderInRouter(<AutoscalerBounds name="web" namespace="team-a" min={2} max={5} targetCpuPercent={80} />);
        await userEvent.click(await screen.findByRole('button', { name: 'Edit bounds' }));
        const panel = await screen.findByTestId('autoscaler-bounds');
        const max = within(panel).getByLabelText('Maximum replicas');
        await userEvent.clear(max);
        await userEvent.type(max, '9');
        await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('autoscalers.update', {
                context: 'alpha',
                name: 'web',
                namespace: 'team-a',
                minReplicas: 2,
                maxReplicas: 9,
            }),
        );
    });

    it('sends the CPU target when it was changed', async () => {
        const { AutoscalerBounds } = await import('@/components/workload/autoscaler-bounds');
        renderInRouter(<AutoscalerBounds name="web" namespace="team-a" min={2} max={5} targetCpuPercent={80} />);
        await userEvent.click(await screen.findByRole('button', { name: 'Edit bounds' }));
        const panel = await screen.findByTestId('autoscaler-bounds');
        const cpu = within(panel).getByLabelText('Target CPU %');
        await userEvent.clear(cpu);
        await userEvent.type(cpu, '65');
        await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('autoscalers.update', {
                context: 'alpha',
                name: 'web',
                namespace: 'team-a',
                minReplicas: 2,
                maxReplicas: 5,
                targetCpuPercent: 65,
            }),
        );
    });

    it('refuses a maximum below the minimum rather than sending it', async () => {
        const { AutoscalerBounds } = await import('@/components/workload/autoscaler-bounds');
        renderInRouter(<AutoscalerBounds name="web" namespace="team-a" min={3} max={5} />);
        await userEvent.click(await screen.findByRole('button', { name: 'Edit bounds' }));
        const panel = await screen.findByTestId('autoscaler-bounds');
        const max = within(panel).getByLabelText('Maximum replicas');
        await userEvent.clear(max);
        await userEvent.type(max, '1');
        expect(panel).toHaveTextContent('must be at least the minimum');
        expect(within(panel).getByRole('button', { name: 'Save' })).toBeDisabled();
        expect(invoke).not.toHaveBeenCalledWith('autoscalers.update', expect.anything());
    });

    it('leaves the CPU target alone when the autoscaler watches something else', async () => {
        const { AutoscalerBounds } = await import('@/components/workload/autoscaler-bounds');
        renderInRouter(<AutoscalerBounds name="web" namespace="team-a" min={1} max={4} />);
        await userEvent.click(await screen.findByRole('button', { name: 'Edit bounds' }));
        await userEvent.click(
            within(await screen.findByTestId('autoscaler-bounds')).getByRole('button', { name: 'Save' }),
        );
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('autoscalers.update', {
                context: 'alpha',
                name: 'web',
                namespace: 'team-a',
                minReplicas: 1,
                maxReplicas: 4,
            }),
        );
    });
});
