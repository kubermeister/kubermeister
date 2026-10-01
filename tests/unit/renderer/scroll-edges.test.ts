import { describe, expect, it } from 'vitest';
import { scrollEdges } from '@/lib/scroll-edges';

const row = (scrollLeft: number, clientWidth = 500, scrollWidth = 1200) => ({ scrollLeft, clientWidth, scrollWidth });

describe('scroll edges', () => {
    it('has neither edge when the row fits', () => {
        expect(scrollEdges(row(0, 500, 500))).toEqual({ start: false, end: false });
    });

    it('continues past the end from the start, past both in the middle, past the start at the end', () => {
        expect(scrollEdges(row(0))).toEqual({ start: false, end: true });
        expect(scrollEdges(row(300))).toEqual({ start: true, end: true });
        expect(scrollEdges(row(700))).toEqual({ start: true, end: false });
    });

    it('allows a pixel of slack, since a scaled display scrolls to fractions', () => {
        expect(scrollEdges(row(0.5))).toEqual({ start: false, end: true });
        expect(scrollEdges(row(699.5))).toEqual({ start: true, end: false });
    });
});
