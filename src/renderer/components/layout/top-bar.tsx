import { Fragment, useState } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';
import {
    ArrowLeftIcon,
    ArrowRightIcon,
    CheckIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    Loader2Icon,
    TagIcon,
} from 'lucide-react';
import { StatusDot } from '@/components/data-display/status-dot';
import { Button } from '@/components/ui/button';
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandLoading,
} from '@/components/ui/command';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { breadcrumbsForPath } from '@/lib/nav';
import { useIpcQuery } from '@/lib/query';
import { useSelectNamespace, useSwitchContext } from '@/lib/scope';
import { useRefreshIntervalMs } from '@/lib/settings';
import { CLUSTER_TONE, type StatusTone } from '@/lib/status';
import { cn } from '@/lib/utils';
import { ConnectionNotice } from './connection-notice';
import { NavLink } from './nav-link';
import { ForwardManager } from './forward-manager';
import { UpdatePill } from './update-pill';

export function TopBar() {
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const crumbs = breadcrumbsForPath(pathname);
    const router = useRouter();

    return (
        <header
            className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border bg-background px-4 select-none"
            data-testid="top-bar"
        >
            <Button variant="ghost" size="icon-xs" aria-label="Back" onClick={() => router.history.back()}>
                <ArrowLeftIcon />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label="Forward" onClick={() => router.history.forward()}>
                <ArrowRightIcon />
            </Button>
            <div className="h-4 w-px bg-border" />
            <ContextSelector />
            <NamespaceSelector />
            <ConnectionNotice />
            {crumbs.length > 0 && <div className="ml-1 h-4 w-px bg-border" />}
            <nav aria-label="Breadcrumb" className="flex items-center gap-2.5 text-body" data-testid="breadcrumbs">
                {crumbs.map((crumb, i) => {
                    const Icon = crumb.icon;
                    const last = i === crumbs.length - 1;
                    const content = (
                        <span className={cn('flex items-center gap-1.5', last ? 'text-foreground' : 'text-text-muted')}>
                            {Icon && <Icon className="size-3" />}
                            {crumb.label}
                        </span>
                    );
                    return (
                        <Fragment key={i}>
                            {i > 0 && <ChevronRightIcon className="size-3 text-text-dim" />}
                            {crumb.to && !last ? (
                                <NavLink to={crumb.to} className="hover:text-foreground">
                                    {content}
                                </NavLink>
                            ) : (
                                content
                            )}
                        </Fragment>
                    );
                })}
            </nav>
            <div className="flex-1" />
            <ForwardManager />
            <UpdatePill />
            <Button size="sm" asChild>
                <NavLink to="/create">Create resource</NavLink>
            </Button>
        </header>
    );
}

const NO_CLUSTER: { tone: StatusTone; title: string } = { tone: 'neutral', title: 'No active cluster' };
const HEALTH_TITLE = {
    Healthy: 'Cluster reachable, all nodes ready',
    Degraded: 'Cluster unreachable or nodes not ready',
} as const;

/** Switch kube-context; the dot carries the active cluster's health. */
export function ContextSelector() {
    const contexts = useIpcQuery('contexts.list', {});
    const cluster = useIpcQuery('cluster.active', {}, { refetchInterval: useRefreshIntervalMs() });
    const current = contexts.data?.find((c) => c.current);
    const health = cluster.data
        ? { tone: CLUSTER_TONE[cluster.data.status], title: HEALTH_TITLE[cluster.data.status] }
        : NO_CLUSTER;
    const [switching, setSwitching] = useState(false);
    const switchContext = useSwitchContext();

    const select = async (name: string) => {
        if (name === current?.name) return;
        setSwitching(true);
        try {
            await switchContext(name);
        } finally {
            setSwitching(false);
        }
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 px-2.5"
                    aria-label="Kubernetes context"
                    data-testid="context-selector"
                >
                    <StatusDot tone={health.tone} title={health.title} />
                    <span className="font-medium">{current?.name ?? 'No cluster'}</span>
                    <ChevronDownIcon className="size-3 text-text-muted" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>Contexts</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {(contexts.data ?? []).map((ctx) => (
                    <DropdownMenuItem
                        key={ctx.name}
                        onSelect={() => void select(ctx.name)}
                        disabled={switching}
                        className="flex-col items-start gap-0.5"
                    >
                        <span className="flex w-full items-center gap-1.5 text-body font-medium">
                            <CheckIcon className={cn('size-3 text-primary', !ctx.current && 'invisible')} />
                            {ctx.name}
                        </span>
                        <span className="pl-4.5 text-label text-text-muted">{ctx.cluster}</span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

const ALL_NAMESPACES = 'All namespaces';

/** Scope namespaced lists to one namespace or all, with a filter box. Names only: a pod count beside
 * each would be a whole-cluster pod list dressed as a label. */
export function NamespaceSelector() {
    const namespaces = useIpcQuery('namespaces.list', {});
    const active = useIpcQuery('namespace.active', {});
    const [open, setOpen] = useState(false);
    // A null name is the all-namespaces selection; undefined means the selection is not known yet.
    const activeName = active.data?.name ?? undefined;
    const allSelected = active.data?.name === null;
    const selectNamespace = useSelectNamespace();
    // Every scope switch resets both queries, so this is the state after each switch, not only at launch.
    const loading = active.isPending || namespaces.isPending;

    const select = async (namespace: string | null) => {
        setOpen(false);
        await selectNamespace(namespace);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 px-2.5 text-text-2"
                    aria-label="Namespace"
                    aria-busy={loading}
                    data-testid="namespace-selector"
                >
                    {loading ? (
                        <Loader2Icon className="size-3 animate-spin text-text-muted" aria-hidden />
                    ) : (
                        <TagIcon className="size-3 text-text-muted" />
                    )}
                    <span data-testid="active-namespace">
                        {/* Until the selection is known, "All namespaces" would be a claim rather than a label,
                            and so would it be when the selection could not be read at all. */}
                        {active.isPending
                            ? 'Loading…'
                            : active.isError
                              ? 'Unavailable'
                              : (activeName ?? ALL_NAMESPACES)}
                    </span>
                    <ChevronDownIcon className="size-3 text-text-muted" />
                </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
                <Command>
                    <CommandInput placeholder="Filter namespaces…" />
                    <CommandList>
                        <CommandEmpty>No namespaces found.</CommandEmpty>
                        <CommandGroup heading="Namespaces">
                            <CommandItem value={ALL_NAMESPACES} onSelect={() => void select(null)} className="gap-1.5">
                                <CheckIcon className={cn('size-3 text-primary', !allSelected && 'invisible')} />
                                <span>{ALL_NAMESPACES}</span>
                            </CommandItem>
                            {namespaces.isPending && (
                                <CommandLoading label="Loading namespaces">
                                    {/* cmdk wraps children in a block div of its own; the row layout must sit inside it. */}
                                    <span className="flex items-center gap-1.5">
                                        <Loader2Icon className="size-3 animate-spin" aria-hidden />
                                        <span>Loading namespaces…</span>
                                    </span>
                                </CommandLoading>
                            )}
                            {(namespaces.data ?? []).map((ns) => (
                                <CommandItem
                                    key={ns.name}
                                    value={ns.name}
                                    onSelect={() => void select(ns.name)}
                                    className="gap-1.5"
                                >
                                    <CheckIcon
                                        className={cn('size-3 text-primary', ns.name !== activeName && 'invisible')}
                                    />
                                    <span className="flex-1">{ns.name}</span>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
