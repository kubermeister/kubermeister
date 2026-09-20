import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Following the end of a growing scroll container. Kept apart from the log console because this is
 * the part worth testing on its own: when the end counts as on screen, and when the follow hands
 * control back to the reader.
 */

/** How near the end still counts as the end: one row, so a partly measured last row never detaches. */
export const BOTTOM_SLACK_PX = 24;

/** The three numbers that say whether a container's end is on screen. */
export interface ScrollMetrics {
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
}

export function isAtBottom(metrics: ScrollMetrics, slack = BOTTOM_SLACK_PX): boolean {
    return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= slack;
}

export interface FollowBottom {
    /** True while the view is pinned to the end of the content. */
    following: boolean;
    /** Wire to the container's `onScroll`: scrolling away stops the follow, scrolling back resumes it. */
    onScroll: () => void;
    /** Go to the end and follow again. */
    resume: () => void;
}

/**
 * Keep a scroll container pinned to its end as content grows. The follow stops the moment the
 * reader scrolls away from the end, because a console that yanks the view back mid-sentence is
 * worse than one that never follows, and it resumes when they scroll back to it.
 */
export function useFollowBottom(
    ref: RefObject<HTMLElement | null>,
    /** The content's height; growing is the only thing the follow reacts to. */
    contentHeight: number,
    /** Changes when the content is replaced wholesale, which starts a new log following again. */
    resetKey: string,
): FollowBottom {
    const [following, setFollowing] = useState(true);
    // Reset during render rather than from an effect, which would paint the new log at the old
    // scroll position first.
    const [trackedKey, setTrackedKey] = useState(resetKey);
    if (trackedKey !== resetKey) {
        setTrackedKey(resetKey);
        setFollowing(true);
    }

    // Before paint, so the rows and the scroll position land in the same frame.
    useLayoutEffect(() => {
        const element = ref.current;
        if (!element || !following) return;
        element.scrollTop = element.scrollHeight;
    }, [ref, following, contentHeight]);

    return {
        following,
        onScroll: () => {
            const element = ref.current;
            if (element) setFollowing(isAtBottom(element));
        },
        resume: () => {
            const element = ref.current;
            if (element) element.scrollTop = element.scrollHeight;
            setFollowing(true);
        },
    };
}
