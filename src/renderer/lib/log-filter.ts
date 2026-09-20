import type { LogLine } from '../../shared/k8s/logs';

/**
 * What the log console shows and how. Kept apart from the component because this is the part worth
 * testing: a search that can be a regular expression, and where it matched inside a line.
 */

export interface LogSearch {
    query: string;
    /** Treat the query as a regular expression rather than as text to find. */
    regex: boolean;
    caseSensitive: boolean;
    /**
     * Mark the matches in place and keep every line, instead of hiding the ones that do not match.
     * What is being looked for is often only legible next to what surrounds it — a stack trace
     * under the line that named the error, the request that came in before the timeout.
     */
    highlight: boolean;
}

export const NO_SEARCH: LogSearch = { query: '', regex: false, caseSensitive: false, highlight: false };

/**
 * The matcher for one search, or null when the search is empty or its expression is not valid. An
 * unfinished regular expression is a state people type through, so it reads as "no filter yet"
 * rather than as an error that empties the console mid-keystroke.
 */
export function matcherFor(search: LogSearch): ((line: LogLine) => boolean) | null {
    const query = search.query.trim();
    if (!query) return null;
    if (search.regex) {
        try {
            const pattern = new RegExp(query, search.caseSensitive ? '' : 'i');
            return (line) => pattern.test(line.message);
        } catch {
            return null;
        }
    }
    if (search.caseSensitive) return (line) => line.message.includes(query);
    const needle = query.toLowerCase();
    return (line) => line.message.toLowerCase().includes(needle);
}

/** True when the query is meant as a regular expression and is not one yet. */
export function isBrokenPattern(search: LogSearch): boolean {
    if (!search.regex || !search.query.trim()) return false;
    try {
        new RegExp(search.query);
        return false;
    } catch {
        return true;
    }
}

/**
 * The lines to render, in order: the ones the search matched, or all of them when there is no
 * search or the search is marking rather than narrowing.
 */
export function visibleLines<T extends LogLine>(lines: T[], search: LogSearch): T[] {
    if (search.highlight) return lines;
    const matches = matcherFor(search);
    return matches ? lines.filter(matches) : lines;
}

/** Where a search matched inside one message, for marking it in place. */
export function matchRanges(message: string, search: LogSearch): [number, number][] {
    const query = search.query.trim();
    if (!query) return [];
    const flags = search.caseSensitive ? 'g' : 'gi';
    let pattern: RegExp;
    try {
        pattern = new RegExp(search.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    } catch {
        return [];
    }
    const ranges: [number, number][] = [];
    for (const found of message.matchAll(pattern)) {
        const start = found.index ?? 0;
        // A pattern that can match nothing would otherwise mark every position forever.
        if (found[0].length === 0) break;
        ranges.push([start, start + found[0].length]);
        if (ranges.length >= 50) break;
    }
    return ranges;
}
