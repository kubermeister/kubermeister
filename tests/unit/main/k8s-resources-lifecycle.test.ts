import { ApiException, type V1Job } from '@kubernetes/client-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const core = { createNamespacedPodEviction: vi.fn() };
const batch = {
    readNamespacedJob: vi.fn(),
    deleteNamespacedJob: vi.fn(),
    createNamespacedJob: vi.fn(),
    readNamespacedCronJob: vi.fn(),
};
const objects = { patch: vi.fn() };
const hpa = { readNamespacedHorizontalPodAutoscaler: vi.fn() };
const client = {
    apis: () => ({ core, batch, objects, hpa }),
    activeContextName: vi.fn<() => string>(() => 'alpha'),
    getActiveNamespace: vi.fn<() => string | null>(() => 'team-a'),
};
vi.mock('../../../src/main/k8s/client.js', () => client);

const lifecycle = await import('../../../src/main/k8s/resources/lifecycle.js');

const ON_ALPHA = { context: 'alpha', name: 'import', namespace: 'team-a' };

/** A job as the control plane leaves it once it has run: stamped with a selector and uid labels. */
function ranJob(overrides: Partial<V1Job> = {}): V1Job {
    return {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
            name: 'import',
            namespace: 'team-a',
            uid: 'job-1',
            labels: { app: 'import', 'batch.kubernetes.io/controller-uid': 'job-1' },
            annotations: { owner: 'data', 'kubectl.kubernetes.io/last-applied-configuration': '{}' },
        },
        spec: {
            selector: { matchLabels: { 'batch.kubernetes.io/controller-uid': 'job-1' } },
            manualSelector: false,
            backoffLimit: 4,
            template: {
                metadata: { labels: { app: 'import', 'batch.kubernetes.io/job-name': 'import' } },
                spec: { containers: [{ name: 'run', image: 'busybox' }], restartPolicy: 'Never' },
            },
        },
        status: { failed: 1 },
        ...overrides,
    } as V1Job;
}

beforeEach(() => {
    vi.clearAllMocks();
    client.activeContextName.mockReturnValue('alpha');
    core.createNamespacedPodEviction.mockResolvedValue({});
    batch.readNamespacedJob.mockResolvedValue(ranJob());
    batch.deleteNamespacedJob.mockResolvedValue({});
    batch.createNamespacedJob.mockImplementation(async ({ body }: { body: V1Job }) => body);
    objects.patch.mockResolvedValue({});
});

afterEach(() => {
    vi.useRealTimers();
});

describe('evicting a pod', () => {
    it('asks through the eviction API so a disruption budget still has a say', async () => {
        await expect(lifecycle.evictPod({ ...ON_ALPHA, name: 'web-1' })).resolves.toEqual({
            kind: 'Pod',
            name: 'web-1',
            namespace: 'team-a',
        });
        expect(core.createNamespacedPodEviction).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'web-1', namespace: 'team-a' }),
        );
        expect(core.createNamespacedPodEviction.mock.calls[0][0].body.deleteOptions).toBeUndefined();
    });

    it('passes a grace period when one is asked for, and reports a budget refusal', async () => {
        await lifecycle.evictPod({ ...ON_ALPHA, name: 'web-1', gracePeriodSeconds: 0 });
        expect(core.createNamespacedPodEviction.mock.calls[0][0].body.deleteOptions).toEqual({ gracePeriodSeconds: 0 });

        core.createNamespacedPodEviction.mockRejectedValue(new ApiException(429, 'budget', null, {}));
        await expect(lifecycle.evictPod({ ...ON_ALPHA, name: 'web-1' })).rejects.toMatchObject({ op: 'pods.evict' });
    });

    it('refuses an eviction aimed at a context the app has left', async () => {
        client.activeContextName.mockReturnValue('beta');
        await expect(lifecycle.evictPod({ ...ON_ALPHA, name: 'web-1' })).rejects.toMatchObject({ kind: 'conflict' });
        expect(core.createNamespacedPodEviction).not.toHaveBeenCalled();
    });
});

describe('building a job from one that ran', () => {
    it('drops what the control plane stamped and keeps what the author wrote', () => {
        const next = lifecycle.jobFromTemplate(ranJob(), 'import');
        expect(next.spec?.selector).toBeUndefined();
        expect(next.spec?.manualSelector).toBeUndefined();
        expect(next.spec?.backoffLimit).toBe(4);
        expect(next.metadata?.labels).toEqual({ app: 'import' });
        expect(next.metadata?.annotations).toEqual({ owner: 'data' });
        expect(next.spec?.template.metadata?.labels).toEqual({ app: 'import' });
        // Nothing of the finished run comes along.
        expect(next.status).toBeUndefined();
        expect(next.metadata?.uid).toBeUndefined();
    });

    it('leaves nothing behind when every label belonged to the control plane', () => {
        const stamped = ranJob({
            metadata: { name: 'import', namespace: 'team-a', labels: { 'batch.kubernetes.io/controller-uid': 'x' } },
        });
        expect(lifecycle.jobFromTemplate(stamped, 'import').metadata?.labels).toBeUndefined();
    });

    it('stamps a manual run with the time, so two runs never collide', () => {
        const name = lifecycle.manualJobName('nightly', new Date('2026-09-16T10:30:00Z'));
        expect(name).toBe('nightly-2609161030');
        // Names stay within the 63 characters Kubernetes allows.
        expect(lifecycle.manualJobName('x'.repeat(70)).length).toBe(63);
    });
});

describe('running a job again', () => {
    it('deletes the old run, waits for the name, and submits the same spec', async () => {
        batch.readNamespacedJob
            .mockResolvedValueOnce(ranJob())
            .mockRejectedValue(new ApiException(404, 'gone', null, {}));
        await expect(lifecycle.retryJob(ON_ALPHA)).resolves.toEqual({
            kind: 'Job',
            name: 'import',
            namespace: 'team-a',
        });
        // Foreground deletion, so the name is still taken while its pods are cleaned up.
        expect(batch.deleteNamespacedJob).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'import', propagationPolicy: 'Foreground' }),
        );
        const submitted = batch.createNamespacedJob.mock.calls[0][0].body;
        expect(submitted.metadata.name).toBe('import');
        expect(submitted.spec.selector).toBeUndefined();
    });

    it('gives up rather than racing a job whose deletion never finishes', async () => {
        vi.useFakeTimers();
        batch.readNamespacedJob.mockResolvedValue(ranJob());
        const retry = lifecycle.retryJob(ON_ALPHA);
        const settled = expect(retry).rejects.toMatchObject({
            kind: 'conflict',
            detail: expect.stringContaining('still being deleted'),
        });
        await vi.advanceTimersByTimeAsync(25_000);
        await settled;
        expect(batch.createNamespacedJob).not.toHaveBeenCalled();
    });

    it('refuses a retry aimed at a context the app has left', async () => {
        client.activeContextName.mockReturnValue('beta');
        await expect(lifecycle.retryJob(ON_ALPHA)).rejects.toMatchObject({ kind: 'conflict' });
        expect(batch.deleteNamespacedJob).not.toHaveBeenCalled();
    });
});

describe('running and holding a cron job', () => {
    beforeEach(() => {
        batch.readNamespacedCronJob.mockResolvedValue({
            metadata: { name: 'nightly', namespace: 'team-a' },
            spec: { jobTemplate: { metadata: { labels: { app: 'nightly' } }, spec: ranJob().spec } },
        });
    });

    it('creates a job from the cron job’s template, owned by nobody', async () => {
        const result = await lifecycle.triggerCronJob({ ...ON_ALPHA, name: 'nightly' });
        expect(result.kind).toBe('Job');
        expect(result.name).toMatch(/^nightly-\d{10}$/);
        const submitted = batch.createNamespacedJob.mock.calls[0][0].body;
        expect(submitted.metadata.namespace).toBe('team-a');
        // Nothing sweeps it away on the schedule's history limits.
        expect(submitted.metadata.ownerReferences).toBeUndefined();
        expect(submitted.spec.selector).toBeUndefined();
    });

    it('refuses a cron job with no template to run', async () => {
        batch.readNamespacedCronJob.mockResolvedValue({ metadata: { name: 'nightly' }, spec: {} });
        await expect(lifecycle.triggerCronJob({ ...ON_ALPHA, name: 'nightly' })).rejects.toMatchObject({
            kind: 'invalid',
            detail: expect.stringContaining('no job template'),
        });
    });

    it('suspends and resumes the schedule through the flag alone', async () => {
        await lifecycle.setCronJobSuspended({ ...ON_ALPHA, name: 'nightly', suspend: true });
        expect(objects.patch).toHaveBeenCalledWith({
            apiVersion: 'batch/v1',
            kind: 'CronJob',
            metadata: { name: 'nightly', namespace: 'team-a' },
            spec: { suspend: true },
        });
        await lifecycle.setCronJobSuspended({ ...ON_ALPHA, name: 'nightly', suspend: false });
        expect(objects.patch).toHaveBeenLastCalledWith(expect.objectContaining({ spec: { suspend: false } }));
    });

    it('refuses both cron job writes from a context the app has left', async () => {
        client.activeContextName.mockReturnValue('beta');
        const expected = { kind: 'conflict' };
        await expect(lifecycle.triggerCronJob({ ...ON_ALPHA, name: 'nightly' })).rejects.toMatchObject(expected);
        await expect(
            lifecycle.setCronJobSuspended({ ...ON_ALPHA, name: 'nightly', suspend: true }),
        ).rejects.toMatchObject(expected);
        expect(batch.createNamespacedJob).not.toHaveBeenCalled();
        expect(objects.patch).not.toHaveBeenCalled();
    });
});

describe('adjusting an autoscaler', () => {
    it('sends the bounds, and the CPU target only when one was asked for', async () => {
        const target = { context: 'alpha', name: 'web', namespace: 'team-a' };
        hpa.readNamespacedHorizontalPodAutoscaler.mockResolvedValue({
            metadata: { resourceVersion: '41' },
            spec: {
                metrics: [
                    {
                        type: 'Resource',
                        resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 80 } },
                    },
                ],
            },
        });
        await expect(
            lifecycle.updateAutoscaler({ ...target, minReplicas: 2, maxReplicas: 8, targetCpuPercent: 70 }),
        ).resolves.toEqual({ kind: 'HorizontalPodAutoscaler', name: 'web', namespace: 'team-a' });
        expect(objects.patch).toHaveBeenCalledWith({
            apiVersion: 'autoscaling/v2',
            kind: 'HorizontalPodAutoscaler',
            metadata: { name: 'web', namespace: 'team-a', resourceVersion: '41' },
            spec: {
                minReplicas: 2,
                maxReplicas: 8,
                metrics: [
                    {
                        type: 'Resource',
                        resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } },
                    },
                ],
            },
        });

        // An autoscaler watching something else keeps watching it: no metrics are sent at all.
        await lifecycle.updateAutoscaler({ ...target, minReplicas: 1, maxReplicas: 3 });
        expect(objects.patch).toHaveBeenLastCalledWith(
            expect.objectContaining({ spec: { minReplicas: 1, maxReplicas: 3 } }),
        );
    });

    it('changes the CPU target and keeps every other metric the autoscaler watches', async () => {
        const memory = {
            type: 'Resource',
            resource: { name: 'memory', target: { type: 'Utilization', averageUtilization: 75 } },
        };
        const queue = {
            type: 'External',
            external: { metric: { name: 'queue_depth' }, target: { type: 'AverageValue', averageValue: '30' } },
        };
        hpa.readNamespacedHorizontalPodAutoscaler.mockResolvedValue({
            metadata: { resourceVersion: '7' },
            spec: {
                metrics: [
                    memory,
                    {
                        type: 'Resource',
                        resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 80 } },
                    },
                    queue,
                ],
            },
        });
        await lifecycle.updateAutoscaler({
            context: 'alpha',
            name: 'web',
            namespace: 'team-a',
            minReplicas: 2,
            maxReplicas: 6,
            targetCpuPercent: 60,
        });
        expect(objects.patch).toHaveBeenLastCalledWith(
            expect.objectContaining({
                spec: {
                    minReplicas: 2,
                    maxReplicas: 6,
                    // Same order, same neighbours: only the CPU entry's target is different.
                    metrics: [
                        memory,
                        {
                            type: 'Resource',
                            resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 60 } },
                        },
                        queue,
                    ],
                },
            }),
        );
    });

    it('adds a CPU target to an autoscaler that had none, after what it already watches', async () => {
        const memory = {
            type: 'Resource',
            resource: { name: 'memory', target: { type: 'Utilization', averageUtilization: 75 } },
        };
        hpa.readNamespacedHorizontalPodAutoscaler.mockResolvedValue({ metadata: {}, spec: { metrics: [memory] } });
        await lifecycle.updateAutoscaler({
            context: 'alpha',
            name: 'web',
            namespace: 'team-a',
            minReplicas: 1,
            maxReplicas: 4,
            targetCpuPercent: 50,
        });
        expect(objects.patch).toHaveBeenLastCalledWith(
            expect.objectContaining({
                spec: expect.objectContaining({
                    metrics: [
                        memory,
                        {
                            type: 'Resource',
                            resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 50 } },
                        },
                    ],
                }),
            }),
        );
    });

    it('refuses an adjustment aimed at a context the app has left', async () => {
        client.activeContextName.mockReturnValue('beta');
        await expect(
            lifecycle.updateAutoscaler({
                context: 'alpha',
                name: 'web',
                namespace: 'team-a',
                minReplicas: 1,
                maxReplicas: 2,
            }),
        ).rejects.toMatchObject({ kind: 'conflict' });
        expect(objects.patch).not.toHaveBeenCalled();
    });
});
