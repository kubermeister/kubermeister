import { useCallback, useEffect, useRef, useState } from 'react';
import type { DrainEvent, DrainPlan, DrainPod } from '../../shared/k8s/drain';
import type { NodeDrainInput } from '../../shared/streams';
import { stream, type StreamHandle } from './ipc';

/** One line of a drain's progress, as the dialog shows it. */
export interface DrainLine {
    /** Stable key: one line per pod, replaced as that pod's state moves on. */
    key: string;
    text: string;
    state: 'working' | 'done' | 'held';
}

export interface DrainState {
    running: boolean;
    /** True once the node stopped taking new pods, which survives stopping the drain. */
    cordoned: boolean;
    plan: DrainPlan | null;
    lines: DrainLine[];
    evicted: number;
    /** Pods the drain did not get to, because it was stopped or a budget never gave way. */
    left: number | null;
    error: string | null;
    finished: boolean;
}

export const IDLE: DrainState = {
    running: false,
    cordoned: false,
    plan: null,
    lines: [],
    evicted: 0,
    left: null,
    error: null,
    finished: false,
};

const podKey = (pod: DrainPod): string => `${pod.namespace}/${pod.name}`;

/** Replace the line for one pod, or add it: a pod's latest state is the only one worth showing. */
function withLine(lines: DrainLine[], line: DrainLine): DrainLine[] {
    const at = lines.findIndex((existing) => existing.key === line.key);
    if (at === -1) return [...lines, line];
    const next = [...lines];
    next[at] = line;
    return next;
}

/**
 * Fold one drain event into the state the dialog renders. Exported on its own because the whole
 * point of a drain is what it reports while it runs, and that is worth testing without a cluster.
 */
export function applyDrainEvent(state: DrainState, event: DrainEvent): DrainState {
    switch (event.type) {
        case 'cordoned':
            return { ...state, cordoned: true };
        case 'plan':
            return { ...state, plan: event.plan };
        case 'evicting':
            return {
                ...state,
                lines: withLine(state.lines, {
                    key: podKey(event.pod),
                    text: `Evicting ${podKey(event.pod)}`,
                    state: 'working',
                }),
            };
        case 'blocked':
            return {
                ...state,
                lines: withLine(state.lines, {
                    key: podKey(event.pod),
                    text: `Waiting for ${podKey(event.pod)}: ${event.reason}`,
                    state: 'held',
                }),
            };
        case 'evicted':
            return {
                ...state,
                evicted: state.evicted + 1,
                lines: withLine(state.lines, {
                    key: podKey(event.pod),
                    text: `Evicted ${podKey(event.pod)}`,
                    state: 'done',
                }),
            };
        case 'done':
            // Main counted the evictions; its total is the one that survives a dropped event.
            return { ...state, evicted: event.evicted, left: event.left, finished: true, running: false };
    }
}

export interface DrainHandle extends DrainState {
    start: (input: Omit<NodeDrainInput, 'context'>) => void;
    /** Ends the evictions; the node stays cordoned, which the dialog says. */
    stop: () => void;
    /** Stops any drain and forgets the last one, so the dialog opens on a fresh plan. */
    reset: () => void;
}

/**
 * Run one drain and report it as it happens. The stream is stopped when the dialog closes or the
 * page unmounts, so a drain never outlives the screen that asked for it — main stops evicting the
 * moment the stream goes.
 */
export function useNodeDrain(context: string | null): DrainHandle {
    const [state, setState] = useState<DrainState>(IDLE);
    const handle = useRef<StreamHandle | null>(null);

    const stop = useCallback(() => {
        handle.current?.stop();
        handle.current = null;
        setState((s) => (s.running ? { ...s, running: false } : s));
    }, []);

    const reset = useCallback(() => {
        handle.current?.stop();
        handle.current = null;
        setState(IDLE);
    }, []);

    useEffect(() => () => handle.current?.stop(), []);

    const start = useCallback(
        (input: Omit<NodeDrainInput, 'context'>) => {
            if (!context) {
                setState({ ...IDLE, error: 'No context is active.' });
                return;
            }
            handle.current?.stop();
            setState({ ...IDLE, running: true });
            handle.current = stream('nodes.drain', { ...input, context }, (message) => {
                if (message.type === 'data') setState((s) => applyDrainEvent(s, message.data));
                else if (message.type === 'error') setState((s) => ({ ...s, error: message.message, running: false }));
                else setState((s) => ({ ...s, running: false }));
            });
        },
        [context],
    );

    return { ...state, start, stop, reset };
}
