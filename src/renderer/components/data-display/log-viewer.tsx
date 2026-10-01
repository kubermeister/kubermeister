import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { toast } from 'sonner';
import {
    ArrowDownIcon,
    ChevronDownIcon,
    ClockIcon,
    CopyIcon,
    DownloadIcon,
    HighlighterIcon,
    SearchIcon,
    TagIcon,
    WrapTextIcon,
} from 'lucide-react';
import type { LogLine } from '../../../shared/k8s/logs';
import type { ContainerRole } from '../../../shared/k8s/pods';
import { ContainerRoleNote } from '@/components/pod/container-role-note';
import { useFollowBottom } from '@/lib/follow-scroll';
import { TAIL_OPTIONS, useLogViewOptions } from '@/lib/log-view-options';
import { matchRanges, type LogSearch } from '@/lib/log-filter';
import { sharedPodPrefix } from '@/lib/multi-pod-logs';
import { formatLogTimestamp } from '@/lib/log-timestamp';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { describeError } from '@/lib/k8s-error';
import { SCREEN_SEARCH } from '@/lib/shortcuts';
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
    /** Already filtered by the caller: the lines the search left. */
    lines: (LogLine & { pod?: string })[];
    /** Colour per pod, for a view following several at once; absent for a single container. */
    podColors?: Map<string, string>;
    containers: string[];
    /** Which containers are not the app's own, named beside them so a finished init step reads as one. */
    containerRoles?: ReadonlyMap<string, ContainerRole>;
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
    /** True when `lines` has been narrowed by the search. */
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
    containerRoles,
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
    // A pod's label is never cut short at its end: two pods of one workload differ only in the
    // suffix an ellipsis eats. What every followed pod shares is dropped from the front instead, so
    // the label is the part that tells the streams apart, and the full name is the label's title.
    // The column is as wide as the longest label, in `ch`, which is exact in the monospace font.
    const podLabels = useMemo(() => {
        if (!podColors) return { prefix: 0, widthCh: 0 };
        // Read from the lines too, so a pod that has since left the followed set is still labelled
        // by the same rule as the others.
        const pods = new Set(podColors.keys());
        for (const line of lines) if (line.pod) pods.add(line.pod);
        const prefix = sharedPodPrefix(pods);
        let longest = 0;
        for (const pod of pods) longest = Math.max(longest, pod.length);
        // Two more for the brackets the label sits in.
        return { prefix, widthCh: longest - prefix + 2 };
    }, [podColors, lines]);
    // Wrapping changes every row's height, and the virtualiser holds the ones it has measured.
    useEffect(() => virtualizer.measure(), [virtualizer, view.wrap]);
    // A log is read from its end: the console follows the newest line while the end is on screen,
    // and a container, since window or Live change is a new log, which is followed from its end too.
    const follow = useFollowBottom(
        scrollRef,
        virtualizer.getTotalSize(),
        `${container ?? ''}\u0000${since.label}\u0000${live}`,
    );

    // Every line of the buffer as the console reads it — the parts on screen, after the search —
    // rather than the rows the virtualiser happens to have mounted.
    const linesAsText = () =>
        lines
            .map((line) =>
                [
                    line.pod && view.podNames ? `[${line.pod.slice(podLabels.prefix)}]` : null,
                    showTimestamps ? formatLogTimestamp(line.timestamp) : null,
                    line.message,
                ]
                    .filter((part) => part !== null)
                    .join(' '),
            )
            .join('\n');
    const copyLines = async () => {
        try {
            await navigator.clipboard.writeText(linesAsText());
        } catch (error) {
            toast.error('Could not copy the log', { description: describeError(error).detail });
            return;
        }
        toast.success(`${lines.length.toLocaleString()} ${lines.length === 1 ? 'line' : 'lines'} copied`);
    };
    // ⌘A in the console is the log, not the whole window. Only the rows in view are in the DOM, so
    // the selection it makes is what can be shown, and a copy while it stands is the whole buffer,
    // which is what "select all" promised.
    const allSelected = useRef(false);
    const selectAll = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const isSelectAll =
            (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a';
        if (!isSelectAll || !scrollRef.current) return;
        event.preventDefault();
        const range = document.createRange();
        range.selectNodeContents(scrollRef.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        allSelected.current = true;
    };
    const copyAll = (event: React.ClipboardEvent<HTMLDivElement>) => {
        if (!allSelected.current || window.getSelection()?.isCollapsed !== false) return;
        event.preventDefault();
        event.clipboardData.setData('text/plain', linesAsText());
    };

    return (
        <Card
            className="@container flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-card py-0 shadow-none"
            data-testid="log-viewer"
            data-live={String(live)}
            data-following={String(follow.following)}
        >
            {/* One row while the console is wide enough to hold it. Narrower, the words naming the
                pickers go first (each picker still says what it is to a screen reader), then the
                search and its toggles move to a row of their own rather than running off the edge. */}
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-border px-3.5 py-2">
                <div className="flex items-center gap-2.5">
                    <span className="hidden text-meta text-text-muted @3xl:inline">Container</span>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="outline"
                                size="xs"
                                disabled={containers.length === 0}
                                aria-label="Container"
                            >
                                <span className="max-w-40 truncate">{container ?? '—'}</span>
                                <ChevronDownIcon />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            {containers.map((c) => (
                                <DropdownMenuItem key={c} onSelect={() => onContainerChange(c)}>
                                    {c}
                                    <ContainerRoleNote role={containerRoles?.get(c)} />
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <span className="ml-2 hidden text-meta text-text-muted @3xl:inline">Since</span>
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
                    <span className="ml-2 hidden text-meta text-text-muted @3xl:inline">Tail</span>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="xs" aria-label="Tail">
                                {(view.tail ?? defaultTail).toLocaleString()}
                                {/* Without its word beside it, a bare number says nothing. */}
                                <span className="@3xl:hidden">lines</span>
                                <ChevronDownIcon />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            {TAIL_OPTIONS.map((size) => (
                                <DropdownMenuItem key={size} onSelect={() => setView({ tail: size })}>
                                    {size.toLocaleString()}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                <div className="ml-auto flex min-w-0 items-center gap-1.5 @3xl:gap-2.5">
                    {/* Narrow, the red border alone says it; the sentence would push the search out. */}
                    {brokenPattern && (
                        <span className="hidden text-label text-danger @3xl:inline">Not a valid pattern yet</span>
                    )}
                    <div className="relative w-[200px] min-w-24 shrink">
                        <SearchIcon className="absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-text-dim" />
                        <Input
                            value={search.query}
                            onChange={(e) => onSearchChange({ ...search, query: e.target.value })}
                            placeholder="search…"
                            aria-label="Filter log lines"
                            {...SCREEN_SEARCH}
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
                    <Toggle
                        pressed={search.highlight}
                        onToggle={() => onSearchChange({ ...search, highlight: !search.highlight })}
                        label="Highlight matches"
                        title="Highlight matches instead of hiding other lines"
                    >
                        <HighlighterIcon />
                    </Toggle>
                    {/* How a line reads, one group apart from the search's own toggles. */}
                    <ButtonGroup aria-label="Line display">
                        <Toggle
                            pressed={view.wrap}
                            onToggle={() => setView({ wrap: !view.wrap })}
                            label="Wrap long lines"
                            title="Wrap long lines"
                        >
                            <WrapTextIcon />
                        </Toggle>
                        {/* Only a console following several pods labels its lines; a pod's own has nothing
                        to hide. */}
                        {podColors && (
                            <Toggle
                                pressed={view.podNames}
                                onToggle={() => setView({ podNames: !view.podNames })}
                                label="Show pod names"
                                title="Show pod names"
                            >
                                <TagIcon />
                            </Toggle>
                        )}
                        <Toggle
                            pressed={showTimestamps}
                            onToggle={() => setView({ timestamps: !showTimestamps })}
                            label="Show timestamps"
                            title="Show timestamps"
                        >
                            <ClockIcon />
                        </Toggle>
                    </ButtonGroup>
                    <Button variant={live ? 'default' : 'outline'} size="xs" onClick={onLiveToggle} aria-pressed={live}>
                        <span
                            aria-hidden
                            className={cn('size-1.5 rounded-full', live ? 'animate-pulse bg-ok' : 'bg-text-dim')}
                        />
                        Live
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Copy logs"
                        title="Copy every line shown"
                        disabled={lines.length === 0}
                        onClick={() => void copyLines()}
                    >
                        <CopyIcon />
                    </Button>
                    <Button variant="ghost" size="icon-xs" aria-label="Download logs" onClick={onDownload}>
                        <DownloadIcon />
                    </Button>
                </div>
            </div>
            {/* Only the rows in view are mounted: the buffer can be tens of thousands of lines, and
                every one of them in the DOM is what makes a log console crawl. */}
            <div className="relative flex min-h-0 flex-1 flex-col">
                <div
                    ref={scrollRef}
                    onScroll={follow.onScroll}
                    // Focusable so ⌘A has somewhere to land, and so the arrows scroll the log.
                    tabIndex={0}
                    onKeyDown={selectAll}
                    onCopy={copyAll}
                    // Any other selection is the reader's own, and copies as the browser has it.
                    onMouseDown={() => {
                        allSelected.current = false;
                    }}
                    onBlur={() => {
                        allSelected.current = false;
                    }}
                    className="min-h-0 flex-1 overflow-auto bg-code-bg py-2 font-mono text-meta outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
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
                                        'absolute top-0 left-0 w-full px-3.5 py-px text-text-2',
                                        // Unwrapped, the labels are columns beside a message that
                                        // runs off to the right. Wrapped, the whole row is one run of
                                        // text: the message continues under its labels rather than
                                        // in a column beside them, which would leave the space under
                                        // the labels empty for as long as the message is.
                                        view.wrap
                                            ? 'whitespace-pre-wrap wrap-anywhere'
                                            : 'flex gap-3 whitespace-nowrap',
                                    )}
                                    style={{ transform: `translateY(${item.start}px)` }}
                                >
                                    {log.pod && view.podNames && (
                                        <span
                                            className={cn(
                                                // A label is one word whatever the row does
                                                // around it: wrapping inside one splits it.
                                                'shrink-0 whitespace-nowrap',
                                                view.wrap && 'mr-3 inline-block',
                                                podColors?.get(log.pod) ?? 'text-text-2',
                                            )}
                                            style={{ minWidth: `${podLabels.widthCh}ch` }}
                                            data-pod={log.pod}
                                            title={log.pod}
                                        >
                                            [{log.pod.slice(podLabels.prefix)}]
                                        </span>
                                    )}
                                    {showTimestamps && (
                                        <span
                                            className={cn(
                                                'shrink-0 whitespace-nowrap text-text-dim',
                                                view.wrap && 'mr-3',
                                            )}
                                            title={log.timestamp}
                                        >
                                            {formatLogTimestamp(log.timestamp)}
                                        </span>
                                    )}
                                    <span className={cn(!view.wrap && 'flex-1')}>{highlight(log.message, search)}</span>
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
                {/* Announced when it changes, which is rarely; the line count beside it changes with
                    every batch and would talk over everything else. */}
                <span role="status">{live ? (follow.following ? 'following' : 'not following') : 'snapshot'}</span>
            </div>
        </Card>
    );
}
