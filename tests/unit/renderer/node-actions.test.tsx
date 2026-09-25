import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderInRouter } from './helpers';

const invoke = vi.fn();
const subscribe = vi.fn(() => () => {});
const streamHandlers: ((message: unknown) => void)[] = [];
const streamStop = vi.fn();
const stream = vi.fn((_channel: string, _input: unknown, onMessage: (message: unknown) => void) => {
    streamHandlers.push(onMessage);
    return { stop: streamStop, send: vi.fn() };
});
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    subscribe,
    stream,
}));

const toasts = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', async () => ({
    ...(await vi.importActual<typeof import('sonner')>('sonner')),
    toast: toasts,
}));

const { CordonButton } = await import('@/components/node/cordon-button');
const { DrainDialog } = await import('@/components/node/drain-dialog');
const { applyDrainEvent, IDLE } = await import('@/lib/node-drain');

const PLAN = {
    evict: [{ name: 'web-1', namespace: 'team-a' }],
    skip: [
        { name: 'agent', namespace: 'kube-system', reason: 'daemonSet' },
        { name: 'cache', namespace: 'team-a', reason: 'emptyDir' },
    ],
};
const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'context.current': { name: 'alpha', cluster: 'a', user: 'u', current: true },
    'nodes.cordon': { kind: 'Node', name: 'node-1' },
    'nodes.drainPlan': PLAN,
};

/** Push one drain event into every open stream, the way main would. */
const emit = (event: unknown) => streamHandlers.forEach((handler) => handler({ type: 'data', data: event }));

beforeEach(() => {
    invoke.mockReset();
    stream.mockClear();
    streamStop.mockReset();
    streamHandlers.length = 0;
    toasts.success.mockReset();
    invoke.mockImplementation(async (channel: string) => data[channel]);
});

describe('drain event folding', () => {
    it('keeps one line per pod, replaced as that pod moves on', () => {
        const pod = { name: 'web-1', namespace: 'team-a' };
        let state = applyDrainEvent(IDLE, { type: 'cordoned' });
        state = applyDrainEvent(state, { type: 'plan', plan: PLAN });
        state = applyDrainEvent(state, { type: 'evicting', pod });
        state = applyDrainEvent(state, { type: 'blocked', pod, reason: 'a disruption budget is holding it back' });
        expect(state.lines).toHaveLength(1);
        expect(state.lines[0]).toMatchObject({ state: 'held' });

        state = applyDrainEvent(state, { type: 'evicted', pod });
        expect(state.lines).toEqual([{ key: 'team-a/web-1', text: 'Evicted team-a/web-1', state: 'done' }]);
        expect(state).toMatchObject({ cordoned: true, evicted: 1, plan: PLAN });

        state = applyDrainEvent(state, { type: 'done', evicted: 1, left: 0 });
        expect(state).toMatchObject({ finished: true, running: false, left: 0 });
    });
});

describe('cordon action', () => {
    it('cordons a schedulable node and uncordons a cordoned one', async () => {
        const { unmount } = renderInRouter(<CordonButton name="node-1" cordoned={false} />);
        await userEvent.click(await screen.findByRole('button', { name: 'Cordon' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('nodes.cordon', {
                context: 'alpha',
                name: 'node-1',
                unschedulable: true,
            }),
        );
        expect(toasts.success).toHaveBeenCalledWith('Node “node-1” cordoned', expect.anything());
        unmount();

        renderInRouter(<CordonButton name="node-1" cordoned />);
        await userEvent.click(await screen.findByRole('button', { name: 'Uncordon' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('nodes.cordon', expect.objectContaining({ unschedulable: false })),
        );
        expect(toasts.success).toHaveBeenCalledWith('Node “node-1” uncordoned', undefined);
    });
});

describe('a refused cordon', () => {
    it('says nothing succeeded', async () => {
        const { IpcError } = await import('@/lib/ipc');
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'nodes.cordon') throw new IpcError({ kind: 'forbidden', detail: 'no', op: channel });
            return data[channel];
        });
        renderInRouter(<CordonButton name="node-1" cordoned={false} />);
        await userEvent.click(await screen.findByRole('button', { name: 'Cordon' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('nodes.cordon', expect.anything()));
        expect(toasts.success).not.toHaveBeenCalled();
    });
});

describe('drain dialog', () => {
    it('shows what will and will not move before anything happens', async () => {
        renderInRouter(<DrainDialog name="node-1" context="alpha" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Drain' }));
        const plan = await screen.findByTestId('drain-plan');
        await waitFor(() => expect(plan).toHaveTextContent('1 pod to evict'));
        expect(plan).toHaveTextContent('2 left alone (1 managed by a daemon set, 1 uses emptyDir storage)');
        // Nothing is written by opening the dialog.
        expect(stream).not.toHaveBeenCalled();
    });

    it('re-reads the plan when an option changes, since the options decide what moves', async () => {
        renderInRouter(<DrainDialog name="node-1" context="alpha" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Drain' }));
        await screen.findByTestId('drain-plan');
        await userEvent.click(screen.getByRole('switch', { name: /emptyDir/ }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('nodes.drainPlan', {
                name: 'node-1',
                force: false,
                deleteEmptyDirData: true,
            }),
        );
    });

    it('reports the drain as it happens and stops it on request', async () => {
        renderInRouter(<DrainDialog name="node-1" context="alpha" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Drain' }));
        await screen.findByTestId('drain-plan');
        await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Drain' }));
        await waitFor(() =>
            expect(stream).toHaveBeenCalledWith(
                'nodes.drain',
                { name: 'node-1', force: false, deleteEmptyDirData: false, context: 'alpha' },
                expect.any(Function),
            ),
        );

        emit({ type: 'cordoned' });
        emit({ type: 'evicting', pod: { name: 'web-1', namespace: 'team-a' } });
        const progress = await screen.findByTestId('drain-progress');
        await waitFor(() => expect(progress).toHaveTextContent('Evicting team-a/web-1'));
        // A log region, so each pod a screen reader has not heard yet is read as it arrives.
        expect(screen.getByRole('log', { name: 'Drain progress' })).toBe(progress);

        await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
        expect(streamStop).toHaveBeenCalled();
        await waitFor(() => expect(progress).toHaveTextContent('The node stays cordoned until you uncordon it'));
    });

    it('says the drain is done, with what it could not move', async () => {
        renderInRouter(<DrainDialog name="node-1" context="alpha" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Drain' }));
        await screen.findByTestId('drain-plan');
        await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Drain' }));
        await waitFor(() => expect(stream).toHaveBeenCalled());
        emit({ type: 'done', evicted: 3, left: 1 });
        await waitFor(() =>
            expect(screen.getByTestId('drain-progress')).toHaveTextContent('Drained: 3 evicted, 1 left.'),
        );
    });

    it('reports a drain the cluster refused, and closes when main ends the stream', async () => {
        renderInRouter(<DrainDialog name="node-1" context="alpha" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Drain' }));
        await screen.findByTestId('drain-plan');
        await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Drain' }));
        await waitFor(() => expect(stream).toHaveBeenCalled());

        streamHandlers.forEach((handler) => handler({ type: 'error', message: 'nodes is forbidden' }));
        await waitFor(() => expect(screen.getByTestId('drain-progress')).toHaveTextContent('nodes is forbidden'));
        streamHandlers.forEach((handler) => handler({ type: 'end' }));
        // The dialog can be dismissed again once the drain is no longer running.
        await userEvent.click(screen.getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    });

    it('keeps the dialog open while a drain is still running', async () => {
        renderInRouter(<DrainDialog name="node-1" context="alpha" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Drain' }));
        await screen.findByTestId('drain-plan');
        await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Drain' }));
        await waitFor(() => expect(stream).toHaveBeenCalled());
        await userEvent.keyboard('{Escape}');
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('refuses to start a drain with no context to aim it at', async () => {
        renderInRouter(<DrainDialog name="node-1" context={null} />);
        await userEvent.click(await screen.findByRole('button', { name: 'Drain' }));
        await screen.findByTestId('drain-plan');
        await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Drain' }));
        await waitFor(() => expect(screen.getByTestId('drain-progress')).toHaveTextContent('No context is active.'));
        expect(stream).not.toHaveBeenCalled();
    });
});
