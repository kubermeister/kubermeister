import { act, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamMessage } from '../../../src/shared/streams';
import type { LogLine } from '../../../src/shared/k8s/logs';
import { renderWithQuery } from './helpers';

const invoke = vi.fn();
const opened: { pod: string; onMessage: (message: StreamMessage<LogLine>) => void; stop: () => void }[] = [];
const stream = vi.fn((_channel: string, input: { name: string }, onMessage: (message: unknown) => void) => {
    const handle = { stop: vi.fn(), send: vi.fn() };
    opened.push({ pod: input.name, onMessage: onMessage as never, stop: handle.stop });
    return handle;
});
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    stream,
}));

const download = vi.fn();
vi.mock('@/lib/download', () => ({ downloadTextFile: download }));

const { podColors, useMultiPodLogStream } = await import('@/lib/multi-pod-logs');
const { WorkloadLogs } = await import('@/components/workload/workload-logs-tab');

const SETTINGS = {
    version: 1,
    session: { lastContext: null, lastNamespace: null, restoreOnLaunch: true },
    connection: { kubeconfigPath: null },
    data: { refreshIntervalSec: 12, logBufferLines: 2000 },
    updates: { mode: 'check' },
    window: { bounds: null },
};
const pods = [
    {
        name: 'web-1',
        namespace: 'team-a',
        status: 'Running',
        ready: '1/1',
        restarts: 0,
        age: '1h',
        node: 'n1',
        cpu: 0,
        mem: 0,
        cpuLimit: 0,
        memLimit: 0,
    },
    {
        name: 'web-2',
        namespace: 'team-a',
        status: 'Running',
        ready: '1/1',
        restarts: 0,
        age: '1h',
        node: 'n1',
        cpu: 0,
        mem: 0,
        cpuLimit: 0,
        memLimit: 0,
    },
];
const line = (message: string): LogLine => ({ level: 'INFO', timestamp: '2026-09-16T12:00:00Z', message });

beforeEach(() => {
    // Real frames run after the push that scheduled them; a synchronous stub would defeat the
    // batching the hook relies on and lose every line but the first.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    invoke.mockReset();
    stream.mockClear();
    download.mockReset();
    opened.length = 0;
    invoke.mockImplementation(async (channel: string) => (channel === 'settings.get' ? SETTINGS : pods));
});

describe('colouring pods', () => {
    it('gives each pod a colour and keeps it as the set changes around it', () => {
        const first = podColors(['web-2', 'web-1']);
        expect(new Set(first.values()).size).toBe(2);
        // Sorted, so a pod's colour does not depend on the order the API happened to list it in.
        expect(podColors(['web-1', 'web-2']).get('web-1')).toBe(first.get('web-1'));
    });

    it('cycles colours when there are more pods than colours', () => {
        const many = podColors(Array.from({ length: 9 }, (_, i) => `pod-${i}`));
        expect(many.size).toBe(9);
        expect(new Set(many.values()).size).toBeLessThan(9);
    });
});

describe('following several pods', () => {
    it('opens one stream per pod and tags every line with where it came from', async () => {
        const { result } = renderHook(() =>
            useMultiPodLogStream(['web-1', 'web-2'], { namespace: 'team-a', tailLines: 100 }),
        );
        expect(stream).toHaveBeenCalledTimes(2);
        expect(result.current.live).toBe(true);

        act(() => {
            opened[0]!.onMessage({ type: 'data', data: line('from one') });
            opened[1]!.onMessage({ type: 'data', data: line('from two') });
        });
        await waitFor(() => expect(result.current.lines).toHaveLength(2));
        expect(result.current.lines.map((l) => [l.pod, l.message])).toEqual([
            ['web-1', 'from one'],
            ['web-2', 'from two'],
        ]);
    });

    it('keeps one pod’s failure without silencing the rest', async () => {
        const { result } = renderHook(() => useMultiPodLogStream(['web-1', 'web-2'], { namespace: 'team-a' }));
        act(() => {
            opened[0]!.onMessage({ type: 'error', message: 'forbidden' });
            opened[1]!.onMessage({ type: 'data', data: line('still going') });
        });
        await waitFor(() => expect(result.current.failures).toEqual({ 'web-1': 'forbidden' }));
        // The surviving pod's line still arrives, on its own frame.
        await waitFor(() => expect(result.current.lines).toHaveLength(1));
    });

    it('follows nothing, and reports not live, when there are no pods', () => {
        const { result } = renderHook(() => useMultiPodLogStream([], { namespace: 'team-a' }));
        expect(stream).not.toHaveBeenCalled();
        expect(result.current.live).toBe(false);
    });

    it('stops every stream and starts again when the set of pods changes', async () => {
        const { rerender } = renderHook(
            ({ names }: { names: string[] }) => useMultiPodLogStream(names, { namespace: 'team-a' }),
            {
                initialProps: { names: ['web-1'] },
            },
        );
        expect(stream).toHaveBeenCalledTimes(1);
        const first = opened[0]!;
        rerender({ names: ['web-1', 'web-2'] });
        await waitFor(() => expect(first.stop).toHaveBeenCalled());
        expect(stream).toHaveBeenCalledTimes(3);
    });

    it('drops the oldest lines once the buffer is full, across all pods', async () => {
        const { result } = renderHook(() => useMultiPodLogStream(['web-1', 'web-2'], { namespace: 'team-a' }, 2));
        act(() => {
            opened[0]!.onMessage({ type: 'data', data: line('one') });
            opened[0]!.onMessage({ type: 'data', data: line('two') });
            opened[1]!.onMessage({ type: 'data', data: line('three') });
        });
        await waitFor(() => expect(result.current.lines.map((l) => l.message)).toEqual(['two', 'three']));
    });
});

describe('the workload logs tab', () => {
    it('follows every pod of the workload the moment it opens, and says how many', async () => {
        renderWithQuery(<WorkloadLogs kind="Deployment" name="web" namespace="team-a" />);
        await waitFor(() => expect(screen.getByRole('button', { name: 'Container' })).toHaveTextContent('2 pods'));
        // One stream per pod, opened without anybody pressing Live.
        await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));

        act(() => opened[0]!.onMessage({ type: 'data', data: line('hello from web-1') }));
        const rows = await screen.findByRole('list', { name: 'Log lines' });
        await waitFor(() => expect(rows).toHaveTextContent('hello from web-1'));
        // The pod's name rides with its line, since two streams are interleaved.
        expect(rows.querySelector('[data-pod="web-1"]')).toHaveTextContent('web-1');
    });

    it('shows every pod name in full, sized to the longest one', async () => {
        const long = 'payment-gateway-worker-5f9c7d8b64-2xk9p';
        const short = 'web-1';
        invoke.mockImplementation(async (channel: string) =>
            channel === 'settings.get'
                ? SETTINGS
                : [
                      { ...pods[0]!, name: long },
                      { ...pods[1]!, name: short },
                  ],
        );
        renderWithQuery(<WorkloadLogs kind="Deployment" name="web" namespace="team-a" />);
        await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
        act(() => opened.forEach((open) => open.onMessage({ type: 'data', data: line('hello') })));

        const rows = await screen.findByRole('list', { name: 'Log lines' });
        await waitFor(() => expect(rows.querySelector(`[data-pod="${long}"]`)).toBeInTheDocument());
        const cell = rows.querySelector(`[data-pod="${long}"]`)!;
        // The whole name, not a prefix and an ellipsis.
        expect(cell).toHaveTextContent(long);
        expect(cell.className).not.toContain('truncate');
        // Both columns are one width, so the rows still line up, and it fits the longest name.
        expect(cell.getAttribute('style')).toContain(`width: ${long.length}ch`);
        expect(rows.querySelector(`[data-pod="${short}"]`)?.getAttribute('style')).toContain(`width: ${long.length}ch`);
    });

    it('lets every stream go when Live is turned off', async () => {
        renderWithQuery(<WorkloadLogs kind="Deployment" name="web" namespace="team-a" />);
        await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));

        await userEvent.click(screen.getByRole('button', { name: 'Live' }));
        await waitFor(() => opened.forEach((open) => expect(open.stop).toHaveBeenCalled()));
        expect(screen.getByTestId('log-viewer')).toHaveAttribute('data-live', 'false');
    });

    it('downloads what is on screen, with the pod each line came from', async () => {
        renderWithQuery(<WorkloadLogs kind="Deployment" name="web" namespace="team-a" />);
        await waitFor(() => expect(stream).toHaveBeenCalled());
        act(() => opened[0]!.onMessage({ type: 'data', data: line('saved') }));
        await waitFor(() => expect(screen.getByTestId('log-status')).toHaveTextContent('1 lines'));
        await userEvent.click(screen.getByRole('button', { name: 'Download logs' }));
        expect(download).toHaveBeenCalledWith('web-pods.log', 'web-1 2026-09-16T12:00:00Z INFO saved');
    });

    it('surfaces a failing pod through the viewer', async () => {
        renderWithQuery(<WorkloadLogs kind="Deployment" name="web" namespace="team-a" />);
        await waitFor(() => expect(stream).toHaveBeenCalled());
        act(() => opened[0]!.onMessage({ type: 'error', message: 'forbidden' }));
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('web-1: forbidden'));
    });
});
