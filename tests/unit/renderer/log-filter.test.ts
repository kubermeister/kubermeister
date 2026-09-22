import { describe, expect, it } from 'vitest';
import type { LogLine } from '../../../src/shared/k8s/logs';
import {
    isBrokenPattern,
    matchRanges,
    matcherFor,
    NO_SEARCH,
    visibleLines,
} from '../../../src/renderer/lib/log-filter';

const line = (message: string): LogLine => ({
    timestamp: '2026-09-16T12:00:00Z',
    message,
});

const lines = [line('starting up'), line('connection refused'), line('retrying in 5s'), line('cache warm')];

describe('searching logs', () => {
    it('finds text case-insensitively by default, and exactly when asked', () => {
        expect(matcherFor({ ...NO_SEARCH, query: 'REFUSED' })!(line('connection refused'))).toBe(true);
        expect(matcherFor({ ...NO_SEARCH, query: 'REFUSED', caseSensitive: true })!(line('connection refused'))).toBe(
            false,
        );
    });

    it('reads a pattern as one when asked, and treats regex characters literally otherwise', () => {
        expect(matcherFor({ ...NO_SEARCH, query: 'ref.sed', regex: true })!(line('connection refused'))).toBe(true);
        expect(matcherFor({ ...NO_SEARCH, query: 'ref.sed' })!(line('connection refused'))).toBe(false);
    });

    it('treats an unfinished pattern as no filter rather than emptying the console mid-keystroke', () => {
        expect(matcherFor({ ...NO_SEARCH, query: 'refused(', regex: true })).toBeNull();
        expect(isBrokenPattern({ ...NO_SEARCH, query: 'refused(', regex: true })).toBe(true);
        expect(isBrokenPattern({ ...NO_SEARCH, query: 'refused(', regex: false })).toBe(false);
        expect(isBrokenPattern(NO_SEARCH)).toBe(false);
    });

    it('has no matcher at all for an empty search', () => {
        expect(matcherFor(NO_SEARCH)).toBeNull();
        expect(matcherFor({ ...NO_SEARCH, query: '   ' })).toBeNull();
    });
});

describe('what the console shows', () => {
    it('keeps only what the search matched', () => {
        expect(visibleLines(lines, { ...NO_SEARCH, query: 'refused' }).map((l) => l.message)).toEqual([
            'connection refused',
        ]);
    });

    it('shows every line when there is no search', () => {
        expect(visibleLines(lines, NO_SEARCH)).toEqual(lines);
    });

    it('keeps every line when the search marks rather than narrows', () => {
        // The point of the mode: a hit is only legible next to the lines around it.
        expect(visibleLines(lines, { ...NO_SEARCH, query: 'refused', highlight: true })).toEqual(lines);
        // Including a search that matches nothing at all, which would otherwise empty the console.
        expect(visibleLines(lines, { ...NO_SEARCH, query: 'nothing here', highlight: true })).toEqual(lines);
    });

    it('marks where a line matched in either mode', () => {
        for (const highlight of [false, true]) {
            expect(matchRanges('connection refused', { ...NO_SEARCH, query: 'refused', highlight })).toEqual([
                [11, 18],
            ]);
        }
    });
});

describe('marking matches inside a line', () => {
    it('finds every occurrence, as text or as a pattern', () => {
        expect(matchRanges('a-b-a', { ...NO_SEARCH, query: 'a' })).toEqual([
            [0, 1],
            [4, 5],
        ]);
        expect(matchRanges('a-b-a', { ...NO_SEARCH, query: '[ab]', regex: true })).toHaveLength(3);
    });

    it('treats regex characters literally unless the search is a pattern', () => {
        expect(matchRanges('a.b', { ...NO_SEARCH, query: '.' })).toEqual([[1, 2]]);
        expect(matchRanges('a.b', { ...NO_SEARCH, query: '.', regex: true })).toHaveLength(3);
    });

    it('gives up on a pattern that matches nothing, rather than marking every position', () => {
        expect(matchRanges('anything', { ...NO_SEARCH, query: 'x*', regex: true })).toEqual([]);
        expect(matchRanges('anything', { ...NO_SEARCH, query: 'x(', regex: true })).toEqual([]);
        expect(matchRanges('anything', NO_SEARCH)).toEqual([]);
    });

    it('stops marking after fifty matches in one line', () => {
        expect(matchRanges('a'.repeat(200), { ...NO_SEARCH, query: 'a' })).toHaveLength(50);
    });
});
