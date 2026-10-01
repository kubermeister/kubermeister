import { useCallback, useEffect, useState, type RefObject } from 'react';

/** Which ends of a sideways-scrolling row have more of it past them. */
export interface ScrollEdges {
    start: boolean;
    end: boolean;
}

/** A pixel of slack, since a scroll position on a scaled display lands on fractions. */
const SLACK = 1;

export function scrollEdges(element: Pick<HTMLElement, 'scrollLeft' | 'scrollWidth' | 'clientWidth'>): ScrollEdges {
    return {
        start: element.scrollLeft > SLACK,
        end: element.scrollLeft + element.clientWidth < element.scrollWidth - SLACK,
    };
}

const NONE: ScrollEdges = { start: false, end: false };

/**
 * Whether a row that scrolls sideways continues past either edge, kept current as it scrolls, as it
 * is resized and as what it holds changes (`contentKey`), with a way to page it toward one edge. A
 * row that fits has neither edge, so nothing is drawn over it.
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>, contentKey: unknown) {
    const [edges, setEdges] = useState<ScrollEdges>(NONE);

    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        const update = () => {
            const next = scrollEdges(element);
            setEdges((current) => (current.start === next.start && current.end === next.end ? current : next));
        };
        // A ResizeObserver answers once as soon as it observes, which takes the first measurement.
        const observer = new ResizeObserver(update);
        observer.observe(element);
        element.addEventListener('scroll', update, { passive: true });
        return () => {
            observer.disconnect();
            element.removeEventListener('scroll', update);
        };
    }, [ref, contentKey]);

    /** Scroll most of a row's width toward one edge, keeping a little of what was in view. */
    const page = useCallback(
        (direction: -1 | 1) => {
            const element = ref.current;
            if (!element) return;
            element.scrollBy({ left: direction * element.clientWidth * 0.8, behavior: 'smooth' });
        },
        [ref],
    );

    return { edges, page };
}
