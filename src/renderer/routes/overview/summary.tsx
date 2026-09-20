import { createFileRoute } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid } from 'recharts';
import { TriangleAlertIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChartContainer, type ChartConfig } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { EventsList } from '@/components/data-display/events-list';
import { MetricCard } from '@/components/data-display/metric-card';
import { StatusBadge } from '@/components/data-display/status-badge';
import { RefreshButton } from '@/components/refresh-button';
import { ReadErrorHints } from '@/components/templates/read-error-hints';
import { describeError } from '@/lib/k8s-error';
import { useIpcQuery } from '@/lib/query';
import { useRefreshIntervalMs } from '@/lib/settings';
import { CLUSTER_TONE } from '@/lib/status';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/overview/summary')({ component: DashboardPage });

const chartConfig = {
    cpu: { label: 'CPU usage', color: 'var(--chart-1)' },
    mem: { label: 'Memory usage', color: 'var(--chart-4)' },
} satisfies ChartConfig;

const DASHBOARD_KEYS = [
    ['cluster.active'],
    ['events.recent'],
    ['metrics.alerts'],
    ['metrics.sparklines'],
    ['metrics.workloadHealth'],
];
const last = (series: number[]) => series.at(-1) ?? 0;

// The events and alerts panels end the page together and share whatever height is left, each
// scrolling its own rows; below the minimum the page scrolls instead, so a short window doesn't
// squeeze them down to their headers.
const BOTTOM_ROW = 'grid min-h-56 flex-1 grid-cols-[1.6fr_1fr] gap-3';
const PANEL_CARD = 'flex min-h-0 flex-col gap-0 rounded-card py-0 shadow-none';

function DashboardPage() {
    const queryClient = useQueryClient();
    const refetchInterval = useRefreshIntervalMs();
    const clusterQuery = useIpcQuery('cluster.active', {}, { refetchInterval });
    const eventsQuery = useIpcQuery('events.recent', {}, { refetchInterval });
    const alertsQuery = useIpcQuery('metrics.alerts', {}, { refetchInterval });
    const spark = useIpcQuery('metrics.sparklines', {}, { refetchInterval }).data;
    const workloadHealth = useIpcQuery('metrics.workloadHealth', {}, { refetchInterval }).data;

    // Sparklines and workload health are best-effort (empty, not failed, without metrics-server), so
    // reachability is judged on the core reads alone: a failed cluster read must not render as a
    // healthy but idle dashboard. No pod figure at all: counting pods means listing them.
    const coreQueries = [clusterQuery, eventsQuery, alertsQuery];
    const loading = coreQueries.some((q) => q.isPending);
    const failedQuery = coreQueries.find((q) => q.isError);
    const failure = failedQuery ? describeError(failedQuery.error) : null;
    const retry = () => {
        for (const queryKey of DASHBOARD_KEYS) void queryClient.invalidateQueries({ queryKey });
    };

    const cluster = clusterQuery.data;
    const events = eventsQuery.data ?? [];
    const alerts = alertsQuery.data ?? [];
    const sparkCpu = spark?.cpu ?? [];
    const sparkMem = spark?.mem ?? [];
    const memHealth = (workloadHealth ?? []).map((p) => p.mem);
    const avgMem = memHealth.length ? Math.round(memHealth.reduce((a, b) => a + b, 0) / memHealth.length) : 0;
    const peakMem = memHealth.length ? Math.max(...memHealth) : 0;
    const alertTone = alerts.some((a) => a.tone === 'danger') ? 'danger' : alerts.length ? 'warn' : 'neutral';
    const clusterMeta = cluster
        ? `${cluster.provider} · v${cluster.version} · ${cluster.region}`
        : 'No cluster connected';

    return (
        <div className="flex h-full flex-col overflow-auto bg-background p-4" data-testid="cluster-summary">
            <div className="mb-4 flex shrink-0 items-end justify-between">
                <div>
                    <div className="text-label font-medium tracking-wider text-text-muted">CLUSTER OVERVIEW</div>
                    <div className="mt-0.5 flex items-center gap-2.5 text-title font-semibold">
                        {cluster?.name ?? '—'}
                        {cluster && <StatusBadge tone={CLUSTER_TONE[cluster.status]}>{cluster.status}</StatusBadge>}
                    </div>
                    <div className="mt-1 font-mono text-cell text-text-muted">{clusterMeta}</div>
                </div>
                <RefreshButton label="Refresh" queryKeys={DASHBOARD_KEYS} />
            </div>

            {failedQuery ? (
                <Card
                    className="flex shrink-0 flex-col items-center justify-center gap-3 rounded-card py-16 text-center shadow-none"
                    data-testid="dashboard-error"
                >
                    <div className="flex flex-col items-center gap-1 text-body text-text-muted">
                        <span className="font-medium text-foreground">{failure?.title}</span>
                        <span>Couldn't load the cluster overview.</span>
                        {/* The classified reason, so a timeout names its ceiling and a plugin its message. */}
                        {failure && failure.detail !== failure.title && (
                            <span className="max-w-xl text-meta text-text-dim">{failure.detail}</span>
                        )}
                        {/* The summary's reads are cluster-wide by design, so no namespace would narrow them. */}
                        {failure && <ReadErrorHints kind={failure.kind} noun="the cluster overview" />}
                    </div>
                    <Button variant="outline" size="sm" onClick={retry}>
                        Retry
                    </Button>
                </Card>
            ) : loading ? (
                <div className="flex min-h-0 flex-1 flex-col gap-3" role="status" aria-label="Loading">
                    <div className="grid shrink-0 grid-cols-3 gap-3">
                        {Array.from({ length: 3 }).map((_, i) => (
                            <Skeleton key={i} className="h-24 w-full rounded-card" />
                        ))}
                    </div>
                    <Skeleton className="h-44 w-full shrink-0 rounded-card" />
                    <div className={BOTTOM_ROW}>
                        <Skeleton className="h-full w-full rounded-card" />
                        <Skeleton className="h-full w-full rounded-card" />
                    </div>
                </div>
            ) : (
                <>
                    <div className="mb-4 grid shrink-0 grid-cols-3 gap-3" data-testid="dashboard-metrics">
                        <MetricCard
                            label="Nodes"
                            value={`${cluster?.nodes ?? 0}`}
                            sub={cluster?.status ?? '—'}
                            spark={spark?.nodes ?? []}
                            sparkColor="var(--ok)"
                        />
                        <MetricCard
                            label="CPU usage"
                            value={`${last(sparkCpu)}%`}
                            sub="cluster average"
                            spark={sparkCpu}
                            sparkColor="var(--warn)"
                        />
                        <MetricCard
                            label="Memory"
                            value={`${last(sparkMem)}%`}
                            sub="cluster average"
                            spark={sparkMem}
                            sparkColor="var(--danger)"
                        />
                    </div>

                    <Card className="shrink-0 gap-0 rounded-card py-0 shadow-none" data-testid="workload-health">
                        <div className="flex items-center border-b border-border px-3.5 py-3">
                            <div className="text-body font-semibold">Workload health</div>
                            <div className="flex-1" />
                            <span className="font-mono text-label text-text-muted">live · ~12s samples</span>
                        </div>
                        <div className="p-3.5">
                            <ChartContainer config={chartConfig} className="aspect-auto h-32 w-full">
                                <AreaChart
                                    data={workloadHealth ?? []}
                                    margin={{ left: 0, right: 0, top: 4, bottom: 0 }}
                                >
                                    <defs>
                                        <linearGradient id="fillCpu" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="0%" stopColor="var(--color-cpu)" stopOpacity={0.35} />
                                            <stop offset="100%" stopColor="var(--color-cpu)" stopOpacity={0} />
                                        </linearGradient>
                                        <linearGradient id="fillMem" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="0%" stopColor="var(--color-mem)" stopOpacity={0.22} />
                                            <stop offset="100%" stopColor="var(--color-mem)" stopOpacity={0} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid vertical={false} strokeDasharray="0" />
                                    <Area
                                        dataKey="cpu"
                                        type="monotone"
                                        stroke="var(--color-cpu)"
                                        strokeWidth={1.5}
                                        fill="url(#fillCpu)"
                                        isAnimationActive={false}
                                    />
                                    <Area
                                        dataKey="mem"
                                        type="monotone"
                                        stroke="var(--color-mem)"
                                        strokeWidth={1.5}
                                        fill="url(#fillMem)"
                                        isAnimationActive={false}
                                    />
                                </AreaChart>
                            </ChartContainer>
                            <div className="mt-2.5 flex items-center gap-4.5 text-label text-text-muted">
                                <span className="flex items-center gap-1.5">
                                    <span className="h-0.5 w-2" style={{ background: chartConfig.cpu.color }} />
                                    {chartConfig.cpu.label}
                                </span>
                                <span className="flex items-center gap-1.5">
                                    <span className="h-0.5 w-2" style={{ background: chartConfig.mem.color }} />
                                    {chartConfig.mem.label}
                                </span>
                                <div className="flex-1" />
                                {memHealth.length > 0 && (
                                    <span className="font-mono">
                                        mem avg {avgMem}% / peak {peakMem}%
                                    </span>
                                )}
                            </div>
                        </div>
                    </Card>

                    <div className={cn('mt-3', BOTTOM_ROW)}>
                        <Card className={cn(PANEL_CARD, 'min-w-0')} data-testid="recent-events">
                            <div className="flex shrink-0 items-center border-b border-border px-3.5 py-3">
                                <div className="text-body font-semibold">Recent events</div>
                            </div>
                            <div className="min-h-0 flex-1 overflow-auto">
                                <EventsList events={events} emptyMessage="No recent events." />
                            </div>
                        </Card>

                        <Card className={cn(PANEL_CARD, 'min-w-0')} data-testid="alerts">
                            <div className="flex shrink-0 items-center border-b border-border px-3.5 py-3">
                                <div className="text-body font-semibold">Alerts</div>
                                <div className="flex-1" />
                                <Badge variant={alertTone} className="rounded-sm" data-testid="alert-count">
                                    {alerts.length}
                                </Badge>
                            </div>
                            <div className="min-h-0 flex-1 overflow-auto" role="list" aria-label="Alerts">
                                {alerts.length === 0 && (
                                    <div className="px-3.5 py-6 text-center text-cell text-text-muted">
                                        No active alerts.
                                    </div>
                                )}
                                {alerts.map((alert, i) => (
                                    <div
                                        key={`${alert.title}-${alert.detail}`}
                                        role="listitem"
                                        data-tone={alert.tone}
                                        className={cn(
                                            'flex items-start gap-2.5 px-3.5 py-2.5',
                                            i < alerts.length - 1 && 'border-b border-border',
                                        )}
                                    >
                                        <TriangleAlertIcon
                                            className={cn(
                                                'mt-0.5 size-3.5',
                                                alert.tone === 'danger' ? 'text-danger' : 'text-warn',
                                            )}
                                        />
                                        <div className="min-w-0 flex-1">
                                            <div className="text-body font-medium break-words">{alert.title}</div>
                                            <div className="mt-0.5 text-label break-words text-text-muted">
                                                {alert.detail}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    </div>
                </>
            )}
        </div>
    );
}
