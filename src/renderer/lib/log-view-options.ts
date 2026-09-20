import { useCallback, useState } from 'react';

/**
 * How the log console reads, as opposed to which lines it shows. These are preferences about one
 * person's window rather than anything about the cluster, so they live in `localStorage` beside the
 * theme and the column choices instead of in the settings file the app syncs and validates. One key
 * serves every console: how somebody reads a log does not change between a pod's tab and a
 * workload's.
 */
const KEY = 'km-log-view';

export interface LogViewOptions {
    /** Wrap long lines instead of scrolling the console sideways. */
    wrap: boolean;
    /**
     * Show the timestamp on every line. `null` leaves it to the screen showing the log, which is
     * where it starts: a pod stamps every line, a workload following many pods does not, since its
     * rows already spend a column naming the pod. Touching the switch answers it for good.
     */
    timestamps: boolean | null;
}

export const DEFAULT_LOG_VIEW_OPTIONS: LogViewOptions = { wrap: false, timestamps: null };

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
        };
    } catch {
        // Private windows and blocked site data throw on access; the console must still render.
        return DEFAULT_LOG_VIEW_OPTIONS;
    }
}

export function writeLogViewOptions(options: LogViewOptions): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(options));
    } catch {
        // Nothing to do: the choice simply will not survive this window.
    }
}

/** The console's display options, restored on mount and written back as they change. */
export function useLogViewOptions() {
    const [options, setOptions] = useState<LogViewOptions>(readLogViewOptions);
    const update = useCallback((patch: Partial<LogViewOptions>) => {
        setOptions((current) => {
            const next = { ...current, ...patch };
            writeLogViewOptions(next);
            return next;
        });
    }, []);
    return [options, update] as const;
}
