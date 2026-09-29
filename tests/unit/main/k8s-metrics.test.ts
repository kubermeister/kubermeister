import { beforeEach, describe, expect, it, vi } from 'vitest';

const clusterGet = vi.fn();
vi.mock('../../../src/main/k8s/cluster-get.js', () => ({ clusterGet }));
const Metrics = vi.fn();
vi.mock('@kubernetes/client-node', async () => ({
    ...(await vi.importActual<typeof import('@kubernetes/client-node')>('@kubernetes/client-node')),
    Metrics,
}));

const { readPodUsage, readNodeUsage, readUsage } = await import('../../../src/main/k8s/metrics.js');

describe('metrics-server reads', () => {
    beforeEach(() => {
        clusterGet.mockReset();
    });

    it('sums container usage per pod in millicores and MiB, tolerating sparse items', async () => {
        clusterGet.mockResolvedValue({
            items: [
                {
                    metadata: { namespace: 'team-a', name: 'web-1' },
                    containers: [
                        { name: 'app', usage: { cpu: '250m', memory: '64Mi' } },
                        { name: 'side', usage: { cpu: '1', memory: '1Gi' } },
                    ],
                },
                { metadata: { namespace: 'team-a', name: 'bare' } },
                { metadata: { namespace: 'team-a', name: 'partial' }, containers: [{ name: 'app' }] },
            ],
        });
        const usage = await readUsage();
        expect(clusterGet).toHaveBeenCalledWith('/apis/metrics.k8s.io/v1beta1/pods', 'metrics');
        expect(usage.pods.get('team-a/web-1')).toEqual({ cpu: 1250, mem: 1088 });
        expect(usage.pods.get('team-a/bare')).toEqual({ cpu: 0, mem: 0 });
        expect(usage.pods.get('team-a/partial')).toEqual({ cpu: 0, mem: 0 });
        expect(usage.containers.get('team-a/web-1/side')).toEqual({ cpu: 1000, mem: 1024 });
    });

    it('reads node usage by name', async () => {
        clusterGet.mockResolvedValue({
            items: [
                { metadata: { name: 'n1' }, usage: { cpu: '1500m', memory: '2048Mi' } },
                { metadata: { name: 'n2' } },
            ],
        });
        const usage = await readNodeUsage();
        expect(clusterGet).toHaveBeenCalledWith('/apis/metrics.k8s.io/v1beta1/nodes', 'metrics');
        expect(usage.get('n1')).toEqual({ cpu: 1500, mem: 2048 });
        expect(usage.get('n2')).toEqual({ cpu: 0, mem: 0 });
    });

    it('sends through the sender that carries the ceiling, never the library Metrics class', async () => {
        clusterGet.mockResolvedValue({ items: [] });
        await readUsage();
        await readNodeUsage();
        expect(Metrics).not.toHaveBeenCalled();
    });

    it('returns empty maps when metrics-server is absent, unreachable or aborted', async () => {
        clusterGet.mockResolvedValueOnce(null);
        clusterGet.mockResolvedValueOnce(null);
        expect((await readPodUsage()).size).toBe(0);
        expect((await readNodeUsage()).size).toBe(0);
        clusterGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        clusterGet.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
        expect((await readPodUsage()).size).toBe(0);
        expect((await readNodeUsage()).size).toBe(0);
    });
});
