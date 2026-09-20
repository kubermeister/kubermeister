import { useSyncExternalStore } from 'react';

/**
 * How the log console reads, as opposed to which lines it shows. These are preferences about one
 * person's window rather than anything about the cluster, so they live in `localStorage` beside the
 * theme and the column choices instead of in the settings file the app syncs and validates. One key
 * serves every console: how somebody reads a log does not change between a pod's tab and a
 * workload's.
 *
 * They are held in one store outside React rather than in each console's state, because the tail
 * size is read by the screen opening the log as well as by the console showing it, and two copies
 * of a preference are two answers to the same question.
 */
const KEY = 'km-log-view';

/** Tail sizes offered; the screens' own defaults are among them so the picker always has a value. */
export const TAIL_OPTIONS = [100, 500, 1000, 10000] as const;

export interface LogViewOptions {
    /** Wrap long lines instead of scrolling the console sideways. */
    wrap: boolean;
    /**
     * Show the timestamp on every line. `null` leaves it to the screen showing the log, which is
     * where it starts: a pod stamps every line, a workload following many pods does not, since its
     * rows already spend a column naming the pod. Touching the switch answers it for good.
     */
    timestamps: boolean | null;
    /**
     * How many lines one stream reads before following. `null` leaves it to the screen, which is
     * where it starts, since a workload reads its tail once per pod and a pod reads it once.
     */
    tail: number | null;
}

export const DEFAULT_LOG_VIEW_OPTIONS: LogViewOptions = { wrap: false, timestamps: null, tail: null };

export function readLogViewOptions(): LogViewOptions {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return DEFAULT_LOG_VIEW_OPTIONS;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_LOG_VIEW_OPTIONS;
        // Each option is read on its own, so a key written by another version of the app costs the
        // rest of the preferences nothing.
        const stored = parsed as Record<string, unknown>;
        return {
            wrap: typeof stored.wrap === 'boolean' ? stored.wrap : DEFAULT_LOG_VIEW_OPTIONS.wrap,
            timestamps:
                typeof stored.timestamps === 'boolean' ? stored.timestamps : DEFAULT_LOG_VIEW_OPTIONS.timestamps,
            // A tail this version does not offer would leave the picker with nothing selected.
            tail: TAIL_OPTIONS.some((size) => size === stored.tail)
                ? (stored.tail as number)
                : DEFAULT_LOG_VIEW_OPTIONS.tail,
        };
    } catch {
        // Private windows and blocked site data throw on access; the console must still render.
        return DEFAULT_LOG_VIEW_OPTIONS;
    }
}

function writeLogViewOptions(options: LogViewOptions): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(options));
    } catch {
        // Nothing to do: the choice simply will not survive this window.
    }
}

let current: LogViewOptions | null = null;
const listeners = new Set<() => void>();

/** The options as they stand, for a reader that is not a component. */
export function logViewOptions(): LogViewOptions {
    current ??= readLogViewOptions();
    return current;
}

export function setLogViewOptions(patch: Partial<LogViewOptions>): void {
    current = { ...logViewOptions(), ...patch };
    writeLogViewOptions(current);
    for (const listener of listeners) listener();
}

/** Forget the copy in memory and read storage again; the way a test starts from nothing. */
export function resetLogViewOptions(): void {
    current = null;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The console's display options, shared by every reader of them and written back as they change. */
export function useLogViewOptions() {
    return [useSyncExternalStore(subscribe, logViewOptions), setLogViewOptions] as const;
}
