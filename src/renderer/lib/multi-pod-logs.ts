import { useEffect, useRef, useState } from 'react';
import type { LogLine } from '../../shared/k8s/logs';
import { stream, type StreamHandle } from './ipc';
import { LOG_LINE_CAP } from './pod-streams';

/**
 * Following several pods at once. Each pod is its own stream, as it must be — the API server has no
 * call for "the logs of this workload" — and the lines are merged here in arrival order. The pod a
 * line came from travels with it, since that is the only thing that tells two interleaved streams
 * apart on screen.
 */

export interface PodLogLine extends LogLine {
    pod: string;
}

export interface MultiLogState {
    lines: PodLogLine[];
    /** Pods whose follow failed, by name, so one broken stream does not look like silence. */
    failures: Record<string, string>;
    /** True while at least one follow is open; derived from the target, never stored. */
    live: boolean;
}

interface Buffered {
    lines: PodLogLine[];
    failures: Record<string, string>;
}

const IDLE: Buffered = { lines: [], failures: {} };

/** Tailwind text colours cycled over the pods in view; enough that neighbours rarely repeat. */
export const POD_COLORS = [
    'text-primary',
    'text-ok',
    'text-warn',
    'text-accent',
    'text-danger',
    'text-text-2',
] as const;

/** A stable colour per pod: the same pod keeps its colour as others come and go. */
export function podColors(pods: string[]): Map<string, string> {
    const sorted = [...pods].sort();
    return new Map(sorted.map((pod, index) => [pod, POD_COLORS[index % POD_COLORS.length]!]));
}

/** The random tail the API server appends to a `generateName`, which is what tells two replicas apart. */
const GENERATED_SUFFIX = 5;

/**
 * How many leading characters every followed pod shares, which is the part a line's label can drop:
 * a workload's pods differ only at the end, and a long workload name otherwise fills half the
 * console. It never reaches into the shortest name's generated suffix, so a label is never cut
 * mid-way through the part that distinguishes it, and a single pod keeps that suffix rather than
 * being labelled with nothing.
 */
export function sharedPodPrefix(pods: Iterable<string>): number {
    let first: string | undefined;
    let shared = 0;
    let shortest = Infinity;
    for (const pod of pods) {
        shortest = Math.min(shortest, pod.length);
        if (first === undefined) {
            first = pod;
            shared = pod.length;
            continue;
        }
        let at = 0;
        while (at < shared && first[at] === pod[at]) at++;
        shared = at;
    }
    if (first === undefined) return 0;
    return Math.max(0, Math.min(shared, shortest - GENERATED_SUFFIX));
}

/** Keep the newest lines within the cap; the oldest fall off the front as they do for one pod. */
function appendCapped(current: PodLogLine[], incoming: PodLogLine[], cap: number): PodLogLine[] {
    const merged = [...current, ...incoming];
    return merged.length > cap ? merged.slice(-cap) : merged;
}

/**
 * Follow every named pod at once. Restarts when the set of pods changes — a rollout replaces them —
 * and stops every stream when it does, so a pod that has gone stops being followed.
 */
export function useMultiPodLogStream(
    pods: string[],
    options: { namespace: string; sinceSeconds?: number; tailLines?: number } | null,
    cap = LOG_LINE_CAP,
): MultiLogState {
    const key = options && pods.length > 0 ? JSON.stringify({ pods: [...pods].sort(), options }) : null;
    const [state, setState] = useState<Buffered>(IDLE);
    const capRef = useRef(cap);
    useEffect(() => {
        capRef.current = cap;
    }, [cap]);

    // Reset during render when the target changes, so one workload's lines never show under another.
    const [trackedKey, setTrackedKey] = useState(key);
    if (trackedKey !== key) {
        setTrackedKey(key);
        setState(IDLE);
    }

    useEffect(() => {
        if (!key) return;
        const { pods: names, options: opts } = JSON.parse(key) as {
            pods: string[];
            options: { namespace: string; sinceSeconds?: number; tailLines?: number };
        };

        let pending: PodLogLine[] = [];
        let frame: number | undefined;
        const flush = () => {
            frame = undefined;
            const batch = pending;
            pending = [];
            setState((s) => ({ ...s, lines: appendCapped(s.lines, batch, capRef.current) }));
        };

        const handles: StreamHandle[] = names.map((pod) =>
            stream('pods.logs', { ...opts, name: pod }, (message) => {
                if (message.type === 'data') {
                    pending.push({ ...message.data, pod });
                    frame ??= requestAnimationFrame(flush);
                } else if (message.type === 'error') {
                    setState((s) => ({ ...s, failures: { ...s.failures, [pod]: message.message } }));
                }
            }),
        );
        return () => {
            if (frame !== undefined) cancelAnimationFrame(frame);
            for (const handle of handles) handle.stop();
        };
    }, [key]);

    return { ...state, live: key !== null };
}
