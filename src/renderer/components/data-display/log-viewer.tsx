import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownIcon, ChevronDownIcon, DownloadIcon, HighlighterIcon, SearchIcon } from 'lucide-react';
import type { LogLine } from '../../../shared/k8s/logs';
import { LogViewMenu } from '@/components/data-display/log-view-menu';
import { useFollowBottom } from '@/lib/follow-scroll';
import { useLogViewOptions } from '@/lib/log-view-options';
import { matchRanges, type LogSearch } from '@/lib/log-filter';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface SinceOption {
    label: string;
    seconds?: number;
}

export const SINCE_OPTIONS: SinceOption[] = [
    { label: '5 minutes', seconds: 300 },
    { label: '15 minutes', seconds: 900 },
    { label: '1 hour', seconds: 3600 },
    { label: 'All logs', seconds: undefined },
];

export const LOG_LEVEL_COLOR: Record<LogLine['level'], string> = {
    ERROR: 'text-danger',
    WARN: 'text-warn',
    DEBUG: 'text-text-dim',
    INFO: 'text-ok',
};

/** Height of one unwrapped row, which is what the virtualiser starts from before measuring. */
const ROW_HEIGHT = 18;

/**
 * A small on/off control for the console's display options. `label` names it for a screen reader
 * whether or not it is what the button shows: a toggle with an icon still has to say what it is.
 */
function Toggle({
    pressed,
    onToggle,
    label,
    title,
    children,
}: {
    pressed: boolean;
    onToggle: () => void;
    label: string;
    title?: string;
    children?: React.ReactNode;
}) {
    return (
        <Button
            variant={pressed ? 'default' : 'outline'}
            size="xs"
            aria-pressed={pressed}
            aria-label={label}
            title={title}
            onClick={onToggle}
        >
            {children ?? label}
        </Button>
    );
}

/** One message with the search's hits marked in place, so a long line says where it matched. */
function highlight(message: string, search: LogSearch) {
    const ranges = matchRanges(message, search);
    if (ranges.length === 0) return message;
    const parts: (string | React.JSX.Element)[] = [];
    let at = 0;
    ranges.forEach(([start, end], index) => {
        if (start > at) parts.push(message.slice(at, start));
        parts.push(
            <mark key={index} className="rounded-sm bg-warn/30 text-inherit">
                {message.slice(start, end)}
            </mark>,
        );
        at = end;
    });
    if (at < message.length) parts.push(message.slice(at));
    return parts;
}

interface LogViewerProps {
    /** Already filtered by the caller: the lines the search and the level floor left. */
    lines: (LogLine & { pod?: string })[];
    /** Colour per pod, for a view following several at once; absent for a single container. */
    podColors?: Map<string, string>;
    containers: string[];
    container?: string;
    onContainerChange: (container: string) => void;
    since: SinceOption;
    onSinceChange: (since: SinceOption) => void;
    live: boolean;
    onLiveToggle: () => void;
    search: LogSearch;
    onSearchChange: (search: LogSearch) => void;
    /** Whether each line carries its timestamp; the screen decides, there is no control for it. */
    timestamps: boolean;
    onDownload: () => void;
    /** The tail this screen reads when the reader has not chosen one; shown by the View menu. */
    defaultTail: number;
    /** Rendered above the rows when the live stream errors. */
    error?: string | null;
    /** True when `lines` has been narrowed by the search or the level floor. */
    filtered?: boolean;
    /** True when the search is meant as a pattern and is not a valid one yet. */
    brokenPattern?: boolean;
}

/**
 * Presentational log console: container and since pickers, grep, a Live toggle, and the rendered
 * lines. State and the log source (snapshot or live stream) are owned by the caller; how the lines
 * are read is the console's own, since that is a preference about the window rather than about the
 * screen asking for the log.
 */
export function LogViewer({
    lines,
    podColors,
    containers,
    container,
    onContainerChange,
    since,
    onSinceChange,
    live,
    onLiveToggle,
    search,
    onSearchChange,
    timestamps,
    onDownload,
    defaultTail,
    error,
    filtered,
    brokenPattern,
}: LogViewerProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [view, setView] = useLogViewOptions();
    // The screen says whether its lines are worth stamping; the reader overrides it for good.
    const showTimestamps = view.timestamps ?? timestamps;
    // Every row is one unwrapped line, so they all match the estimate; each is still measured so
    // the estimate need not track the font.
    const virtualizer = useVirtualizer({
        count: lines.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 20,
        // A first guess at the console's size, replaced the moment it is measured: without one,
        // nothing is mounted until layout has run, and the first paint of a log is blank.
        initialRect: { width: 900, height: 600 },
    });
    // A log is read from its end: the console follows the newest line while the end is on screen,
    // and a container, since window or Live change is a new log, which is followed from its end too.
    // A pod's name is never cut short: the column is as wide as the longest name it has to carry,
    // in `ch`, which is exact in the console's monospace font. Two pods of one workload differ only
    // in the suffix an ellipsis eats, so a truncated name tells the streams apart no better than
    // none at all.
    const podColumnCh = useMemo(() => {
        if (!podColors) return 0;
        let longest = 0;
        for (const pod of podColors.keys()) longest = Math.max(longest, pod.length);
        // Sized from the lines too, so a name on screen is shown whole even if its pod has since
        // left the followed set.
        for (const line of lines) if (line.pod) longest = Math.max(longest, line.pod.length);
        return longest;
    }, [podColors, lines]);
    // Wrapping changes every row's height, and the virtualiser holds the ones it has measured.
    useEffect(() => virtualizer.measure(), [virtualizer, view.wrap]);
    const follow = useFollowBottom(
        scrollRef,
        virtualizer.getTotalSize(),
        `${container ?? ''}\u0000${since.label}\u0000${live}`,
    );

    return (
        <Card
            className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-card py-0 shadow-none"
            data-testid="log-viewer"
            data-live={String(live)}
            data-following={String(follow.following)}
        >
            <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2">
                <span className="text-meta text-text-muted">Container</span>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="xs" disabled={containers.length === 0} aria-label="Container">
                            {container ?? '—'}
                            <ChevronDownIcon />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        {containers.map((c) => (
                            <DropdownMenuItem key={c} onSelect={() => onContainerChange(c)}>
                                {c}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
                <span className="ml-2 text-meta text-text-muted">Since</span>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="xs" aria-label="Since">
                            {since.label}
                            <ChevronDownIcon />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        {SINCE_OPTIONS.map((option) => (
                            <DropdownMenuItem key={option.label} onSelect={() => onSinceChange(option)}>
                                {option.label}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
                <div className="flex-1" />
                {brokenPattern && <span className="text-label text-danger">Not a valid pattern yet</span>}
                <div className="relative w-[200px]">
                    <SearchIcon className="absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-text-dim" />
                    <Input
                        value={search.query}
                        onChange={(e) => onSearchChange({ ...search, query: e.target.value })}
                        placeholder="search…"
                        aria-label="Filter log lines"
                        className={cn('h-7 pl-7 text-cell', brokenPattern && 'border-danger')}
                    />
                </div>
                <Toggle
                    pressed={search.regex}
                    onToggle={() => onSearchChange({ ...search, regex: !search.regex })}
                    label=".*"
                    title="Read the search as a regular expression"
                />
                <Toggle
                    pressed={search.caseSensitive}
                    onToggle={() => onSearchChange({ ...search, caseSensitive: !search.caseSensitive })}
                    label="Aa"
                    title="Match case"
                />
                {/* Beside the other two because it modifies the search the way they do, rather than
                    in the View menu, which is about how any line reads. */}
                <Toggle
                    pressed={search.highlight}
                    onToggle={() => onSearchChange({ ...search, highlight: !search.highlight })}
                    label="Highlight matches"
                    title="Highlight matches instead of hiding other lines"
                >
                    <HighlighterIcon />
                </Toggle>
                <LogViewMenu
                    wrap={view.wrap}
                    onWrapChange={(wrap) => setView({ wrap })}
                    timestamps={showTimestamps}
                    onTimestampsChange={(value) => setView({ timestamps: value })}
                    tail={view.tail ?? defaultTail}
                    onTailChange={(tail) => setView({ tail })}
                />
                <Button variant={live ? 'default' : 'outline'} size="xs" onClick={onLiveToggle} aria-pressed={live}>
                    <span className={cn('size-1.5 rounded-full', live ? 'animate-pulse bg-ok' : 'bg-text-dim')} />
                    Live
                </Button>
                <Button variant="ghost" size="icon-xs" aria-label="Download logs" onClick={onDownload}>
                    <DownloadIcon />
                </Button>
            </div>
            {/* Only the rows in view are mounted: the buffer can be tens of thousands of lines, and
                every one of them in the DOM is what makes a log console crawl. */}
            <div className="relative flex min-h-0 flex-1 flex-col">
                <div
                    ref={scrollRef}
                    onScroll={follow.onScroll}
                    className="min-h-0 flex-1 overflow-auto bg-code-bg py-2 font-mono text-meta"
                    role="list"
                    aria-label="Log lines"
                    data-testid="log-rows"
                >
                    {error && live && (
                        <div className="px-3.5 py-2 text-danger" role="alert">
                            {error}
                        </div>
                    )}
                    <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
                        {virtualizer.getVirtualItems().map((item) => {
                            const log = lines[item.index]!;
                            return (
                                <div
                                    key={item.key}
                                    ref={virtualizer.measureElement}
                                    data-index={item.index}
                                    role="listitem"
                                    className={cn(
                                        'absolute top-0 left-0 flex w-full gap-3 px-3.5 py-px whitespace-nowrap text-text-2',
                                        // The gutter columns keep their own line while the message
                                        // runs on, so a wrapped line still reads as one row.
                                        view.wrap && 'items-start',
                                    )}
                                    style={{ transform: `translateY(${item.start}px)` }}
                                >
                                    <span className="w-7 shrink-0 text-right text-text-dim">{item.index + 1}</span>
                                    {log.pod && (
                                        <span
                                            className={cn('shrink-0', podColors?.get(log.pod) ?? 'text-text-2')}
                                            style={{ width: `${podColumnCh}ch` }}
                                            data-pod={log.pod}
                                        >
                                            {log.pod}
                                        </span>
                                    )}
                                    {showTimestamps && <span className="shrink-0 text-text-dim">{log.timestamp}</span>}
                                    <span className={cn('w-12 shrink-0 font-medium', LOG_LEVEL_COLOR[log.level])}>
                                        {log.level}
                                    </span>
                                    <span
                                        className={cn('flex-1', view.wrap && 'min-w-0 break-words whitespace-pre-wrap')}
                                    >
                                        {highlight(log.message, search)}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
                {/* Offered only while lines are still arriving: with the stream off nothing is
                    being missed by reading where you are. */}
                {live && !follow.following && (
                    <Button
                        variant="outline"
                        size="xs"
                        className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
                        onClick={follow.resume}
                    >
                        <ArrowDownIcon />
                        Jump to latest
                    </Button>
                )}
            </div>
            <div
                className="flex border-t border-border px-3.5 py-1.5 text-label text-text-muted"
                data-testid="log-status"
            >
                <span>
                    {live ? 'streaming' : 'snapshot'} · <span className="font-mono">{lines.length}</span> lines
                    {filtered && ' (filtered)'}
                </span>
                <div className="flex-1" />
                <span>{live ? (follow.following ? 'following' : 'not following') : 'snapshot'}</span>
            </div>
        </Card>
    );
}
