import { useEffect, useRef, useState } from 'react';
import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';

/**
 * The refreshes of the Refresh buttons on screen, newest last. `Mod+R` runs the newest, so the key
 * refreshes exactly what the screen's own button would, spinning it as a click does.
 */
const screenRefreshes: Array<{ run: () => Promise<void> }> = [];

/**
 * A screen's refresh: invalidate the given query-key groups, or every active query when none are
 * given, with `refreshing` true until the triggered refetches settle.
 */
export function useRefresh(keys?: QueryKey[]): { refresh: () => Promise<void>; refreshing: boolean } {
    const queryClient = useQueryClient();
    const [refreshing, setRefreshing] = useState(false);

    const refresh = async () => {
        if (refreshing) return;
        setRefreshing(true);
        try {
            await (keys
                ? Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
                : queryClient.invalidateQueries());
        } finally {
            setRefreshing(false);
        }
    };
    return { refresh, refreshing };
}

/** Offer `refresh` to the keyboard for as long as the calling component is mounted. */
export function useScreenRefresh(refresh: () => Promise<void>): void {
    const handle = useRef({ run: refresh });
    useEffect(() => {
        handle.current.run = refresh;
    });
    useEffect(() => {
        const entry = handle.current;
        screenRefreshes.push(entry);
        return () => {
            screenRefreshes.splice(screenRefreshes.indexOf(entry), 1);
        };
    }, []);
}

/** What `Mod+R` does: the screen's Refresh button, or every active query on a screen without one. */
export function refreshScreen(queryClient: QueryClient): Promise<void> {
    const newest = screenRefreshes.at(-1);
    return newest ? newest.run() : queryClient.invalidateQueries();
}
