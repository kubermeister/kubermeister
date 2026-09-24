import { useLayoutEffect, type KeyboardEvent, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { useLocation, useNavigate, useParams } from '@tanstack/react-router';
import { CalendarClockIcon, InfoIcon, TagIcon, type LucideIcon } from 'lucide-react';
import type { ObjectEventsInput } from '../../../shared/k8s/events';
import { KINDS, kindInfo, type Kind } from '../../../shared/k8s/registry';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { NavLink } from '@/components/layout/nav-link';
import { DetailCard, PropertyGrid } from '@/components/templates/detail-cards';
import { DetailHeader, type DetailHeaderProps } from '@/components/templates/detail-header';
import { ObjectEvents } from '@/components/templates/object-events';
import { ManifestEditContext, useManifestEditBridge } from '@/components/templates/manifest-edit';
import { ObjectMetaCard } from '@/components/templates/object-meta-card';
import { isManifestKind } from '../../../shared/k8s/manifest';
import { ReadErrorHints } from '@/components/templates/read-error-hints';
import { publishDetailTab } from '@/lib/detail-tab';
import { describeError, readErrorSentence } from '@/lib/k8s-error';
import { cn } from '@/lib/utils';

export interface DetailTab {
    /**
     * The tab's segment in the route (`/workloads/pods/<namespace>/<name>/<id>`), so it is part of
     * a URL from the moment it ships: rename one only knowing an old link then opens the first tab.
     */
    id: string;
    label: string;
    icon: LucideIcon;
    content: ReactNode;
    count?: number;
    hint?: string;
    /**
     * Render the panel as a height-filling flex column instead of the default page-scrolling body,
     * for tabs whose content manages its own scroll (logs, a terminal).
     */
    fill?: boolean;
    /**
     * Keep the panel mounted (hidden) while another tab is active, for tabs holding live state that
     * must survive a switch (a running port-forward, the log buffer). Off by default so most tabs
     * mount lazily and unmount when left.
     */
    keepMounted?: boolean;
}

export interface DetailTabGroup {
    label: string;
    items: DetailTab[];
}

/** Standard "Events" tab: the object's own events with loading, error and empty states. */
export function eventsTab(target: ObjectEventsInput): DetailTab {
    return { id: 'events', label: 'Events', icon: CalendarClockIcon, content: <ObjectEvents {...target} /> };
}

/** Standard "Overview" tab: a Details card of key/value rows. Pages with richer overviews build their own. */
export function overviewTab(rows: [string, string][]): DetailTab {
    return {
        id: 'overview',
        label: 'Overview',
        icon: InfoIcon,
        content: (
            <DetailCard title="Details">
                <PropertyGrid rows={rows} />
            </DetailCard>
        ),
    };
}

/** A titled card listing key/value rows in mono with a "None." empty state; one card per logical group. */
export function KeyValueCard({ title, rows }: { title: string; rows: [string, string][] }) {
    return (
        <Card className="gap-0 rounded-card py-0 shadow-none">
            <div className="border-b border-border px-4 py-3 text-body font-semibold">{title}</div>
            <div>
                {rows.length === 0 && <div className="px-4 py-6 text-center text-cell text-text-muted">None.</div>}
                {rows.map(([k, v], i) => (
                    <div
                        key={k}
                        className={cn(
                            'flex items-center gap-3 px-4 py-2 font-mono text-cell',
                            i < rows.length - 1 && 'border-b border-border',
                        )}
                    >
                        <span className="text-primary">{k}</span>
                        <span className="ml-auto truncate text-text-2">{v}</span>
                    </div>
                ))}
            </div>
        </Card>
    );
}

/** Standard "Labels" tab: labels and annotations as key/value cards, counting the labels on the rail. */
export function labelsTab(meta?: { labels: [string, string][]; annotations: [string, string][] }): DetailTab {
    const labels = meta?.labels ?? [];
    const annotations = meta?.annotations ?? [];
    return {
        id: 'labels',
        label: 'Labels',
        icon: TagIcon,
        count: labels.length || undefined,
        content: (
            <div className="grid grid-cols-2 content-start gap-3">
                <KeyValueCard title="Labels" rows={labels} />
                <KeyValueCard title="Annotations" rows={annotations} />
            </div>
        ),
    };
}

/** The slice of the page's primary query the layout reads to derive load, error and not-found states. */
type DetailQuery = Pick<UseQueryResult<unknown>, 'isPending' | 'isError' | 'isSuccess' | 'error' | 'refetch'>;

interface ResourceDetailProps extends DetailHeaderProps {
    groups: DetailTabGroup[];
    /** The primary query; loading, error and Retry derive from it so the wiring lives in one place. */
    query: DetailQuery;
    /** Whether the page resolved its object; with `query.isSuccess` this yields not-found. */
    found: boolean;
    /** List path the error and not-found panels link back to. */
    backTo?: string;
    /** Human kind for the state copy ("Pod"); falls back to "Resource". */
    kind?: string;
    /** Namespace named in the not-found copy; omitted for cluster-scoped kinds. */
    namespace?: string;
    testId?: string;
}

function StatePanel({ children, testId }: { children: ReactNode; testId?: string }) {
    return (
        <div
            className="grid min-h-0 flex-1 place-items-center border-t border-border px-4.5 pb-4.5"
            data-testid={testId}
        >
            <div className="flex flex-col items-center gap-3 text-center text-body text-text-muted">{children}</div>
        </div>
    );
}

/**
 * The single resource-detail page: an icon, eyebrow and title header over a left-rail tab switcher
 * grouped into labeled sections. Every detail screen composes this with an explicit `groups` array
 * built from the tab factories plus any bespoke tabs. The active tab's content renders in a
 * scrollable region beside the rail.
 */
export function ResourceDetail({
    groups,
    query,
    found,
    backTo,
    kind,
    namespace,
    testId,
    ...header
}: ResourceDetailProps) {
    const allTabs = groups.flatMap((g) => g.items);
    // The tab lives in the route's optional last segment, so a reload or Back lands where the reader
    // was. An id no tab has, such as a tab renamed since a link was made, opens the first tab rather
    // than a not-found page.
    const { tab: tabParam } = useParams({ strict: false });
    const activeTab = allTabs.find((t) => t.id === tabParam) ?? allTabs[0];
    const navigate = useNavigate();
    const pathname = useLocation({ select: (l) => l.pathname });
    // Replacing is what the rail does, so Back leaves the object in one press and the entry it
    // leaves holds the last tab; a jump from outside the rail (the Edit button) pushes. The first
    // tab is written as the bare path, so it has one URL.
    const openTab = (id: string, replace: boolean) => {
        if (id === activeTab?.id) return;
        void navigate({
            to: '.',
            params: (prev) => ({ ...prev, tab: id === allTabs[0]?.id ? undefined : id }),
            replace,
        });
    };
    // The header's Edit action opens the Manifest tab in edit mode; the panel registers the other
    // half of that handshake when it mounts.
    const editControl = useManifestEditBridge(() => openTab('manifest', false));

    // The breadcrumb names the tab by its label; the rail is the only place that knows it.
    const tabLabel = tabParam ? activeTab?.label : undefined;
    useLayoutEffect(() => publishDetailTab(pathname, tabLabel), [pathname, tabLabel]);

    // Roving tabindex with arrow keys across the flat tab order, the WAI-ARIA pattern for a vertical tablist.
    const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
        const delta =
            e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
        if (delta === 0) return;
        e.preventDefault();
        const next = allTabs[(index + delta + allTabs.length) % allTabs.length];
        if (!next) return;
        openTab(next.id, true);
        document.getElementById(`tab-${next.id}`)?.focus();
    };

    // Non-ready states share the header (title is known from the route before the load) and replace
    // the rail and body with one state panel.
    // Some readers (custom resources, Helm releases) answer a missing object with a notFound error
    // rather than null; missing is not a failure, and retrying would only repeat the answer.
    const failure = query.isError ? describeError(query.error) : null;
    const state = query.isPending
        ? 'loading'
        : failure
          ? failure.kind === 'notFound'
              ? 'notFound'
              : 'error'
          : query.isSuccess && !found
            ? 'notFound'
            : 'ready';
    const subject = { one: kind ?? 'resource' };
    const sentence = failure ? readErrorSentence(failure.kind, subject) : '';
    // A cluster-scoped kind lives in no namespace, so the not-found copy names none.
    const clusterScoped = !!kind && (KINDS as readonly string[]).includes(kind) && kindInfo(kind as Kind).clusterScoped;
    const where = clusterScoped ? '' : namespace ? ` in namespace “${namespace}”` : ' in the current namespace';

    return (
        <ManifestEditContext value={editControl}>
            <div className="flex h-full flex-col bg-background" data-testid={testId}>
                <DetailHeader {...header} />

                {state === 'loading' ? (
                    <div
                        className="grid min-h-0 flex-1 grid-cols-[var(--spacing-rail)_1fr] gap-3.5 border-t border-border px-4.5 pt-3.5 pb-4.5"
                        role="status"
                        aria-label="Loading"
                    >
                        <div className="flex flex-col gap-2">
                            {Array.from({ length: 5 }).map((_, i) => (
                                <Skeleton key={i} className="h-7 w-full" />
                            ))}
                        </div>
                        <div className="flex flex-col gap-3">
                            {Array.from({ length: 4 }).map((_, i) => (
                                <Skeleton key={i} className="h-24 w-full" />
                            ))}
                        </div>
                    </div>
                ) : state === 'error' && failure ? (
                    <StatePanel testId="detail-error">
                        <div className="flex flex-col items-center gap-1">
                            <span className="font-medium text-foreground">{failure.title}</span>
                            <span>{sentence}</span>
                            {/* The classified reason, when it says more than the kind already did. */}
                            {failure.detail !== failure.title && failure.detail !== sentence && (
                                <span className="max-w-xl text-meta text-text-dim">{failure.detail}</span>
                            )}
                            <ReadErrorHints kind={failure.kind} noun={`this ${subject.one}`} />
                        </div>
                        <div className="flex gap-2">
                            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                                Retry
                            </Button>
                            {backTo && (
                                <Button variant="ghost" size="sm" asChild>
                                    <NavLink to={backTo}>Back to list</NavLink>
                                </Button>
                            )}
                        </div>
                    </StatePanel>
                ) : state === 'notFound' ? (
                    <StatePanel testId="not-found">
                        <span>
                            {kind ?? 'Resource'} “{header.title}” was not found{where}.
                        </span>
                        {backTo && (
                            <Button variant="outline" size="sm" asChild>
                                <NavLink to={backTo}>Back to list</NavLink>
                            </Button>
                        )}
                    </StatePanel>
                ) : (
                    <div className="grid min-h-0 flex-1 grid-cols-[var(--spacing-rail)_1fr] gap-3.5 border-t border-border px-4.5 pb-4.5">
                        <div
                            role="tablist"
                            aria-orientation="vertical"
                            className="overflow-auto pt-3.5 pr-1 select-none"
                        >
                            {groups.map((group) => (
                                <div key={group.label} role="presentation" className="mb-3.5">
                                    <div className="px-1 pt-1 pb-1.5 text-eyebrow font-semibold tracking-[0.1em] text-text-dim">
                                        {group.label}
                                    </div>
                                    {group.items.map((tab) => {
                                        const TabIcon = tab.icon;
                                        const active = tab.id === activeTab?.id;
                                        return (
                                            <button
                                                key={tab.id}
                                                id={`tab-${tab.id}`}
                                                type="button"
                                                role="tab"
                                                aria-selected={active}
                                                aria-controls={`panel-${tab.id}`}
                                                tabIndex={active ? 0 : -1}
                                                onClick={() => openTab(tab.id, true)}
                                                onKeyDown={(e) => onTabKeyDown(e, allTabs.indexOf(tab))}
                                                className={cn(
                                                    'mb-px flex w-full items-center gap-2.5 border-l-2 py-1.5 pr-2 pl-2 text-left text-body transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                                                    active
                                                        ? 'border-primary bg-elev-2 text-foreground'
                                                        : 'border-transparent text-text-2 hover:bg-elev-2/60',
                                                )}
                                            >
                                                <TabIcon
                                                    className={cn(
                                                        'size-3.25',
                                                        active ? 'text-primary' : 'text-text-muted',
                                                    )}
                                                />
                                                <span className="flex-1">{tab.label}</span>
                                                {tab.count != null && (
                                                    <span className="rounded-[3px] bg-elev-3 px-1.5 font-mono text-caption text-text-muted">
                                                        {tab.count}
                                                    </span>
                                                )}
                                                {tab.hint && (
                                                    <span className="font-mono text-eyebrow text-text-dim">
                                                        {tab.hint}
                                                    </span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            ))}
                        </div>

                        {/* The active tab plus any keepMounted tabs (hidden) so live state survives a switch.
                            `min-w-0` keeps this grid item from growing past its track when a fill tab holds
                            wide content (long log lines, the terminal): the inner region scrolls instead. */}
                        <div
                            className="flex min-h-0 min-w-0 flex-col"
                            data-testid={testId ? `${testId}-body` : undefined}
                        >
                            {allTabs.map((tab) => {
                                const active = tab.id === activeTab?.id;
                                if (!active && !tab.keepMounted) return null;
                                return (
                                    <div
                                        key={tab.id}
                                        id={`panel-${tab.id}`}
                                        role="tabpanel"
                                        aria-labelledby={`tab-${tab.id}`}
                                        tabIndex={0}
                                        hidden={!active}
                                        className={cn(
                                            'min-h-0 pt-3.5 outline-none',
                                            active && 'flex-1',
                                            tab.fill ? 'flex flex-col overflow-hidden' : 'overflow-auto',
                                        )}
                                    >
                                        {tab.fill ? (
                                            tab.content
                                        ) : (
                                            <div className="flex flex-col gap-3">
                                                {/* Owner and finalizers belong to every kind, so
                                                    the Labels tab grows them here rather than in
                                                    thirty screens that each pass the same three
                                                    values to the same card. */}
                                                {tab.id === 'labels' && isManifestKind(kind) && (
                                                    <ObjectMetaCard
                                                        kind={kind}
                                                        name={header.title}
                                                        namespace={namespace}
                                                    />
                                                )}
                                                {tab.content}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </ManifestEditContext>
    );
}
