import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { MetricCard } from '@/components/data-display/metric-card';
import { cn } from '@/lib/utils';

export interface DetailMetric {
    label: string;
    value: string;
    sub?: string;
    spark?: number[];
    sparkColor?: string;
}

/**
 * Columns per number of cards, so the cards share the width between them however many a screen has:
 * a pod's two take half each rather than two of four fixed columns. Four go two by two in a narrow
 * console rather than three and one, and a count no screen has yet wraps as the room allows.
 */
const METRIC_COLUMNS: Record<number, string> = {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-2 @3xl:grid-cols-4',
};

export function DetailMetrics({ metrics }: { metrics: DetailMetric[] }) {
    if (metrics.length === 0) return null;
    return (
        <div className="@container">
            <div
                className={cn(
                    'grid gap-3',
                    METRIC_COLUMNS[metrics.length] ?? 'grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]',
                )}
                data-testid="detail-metrics"
            >
                {metrics.map((metric) => (
                    <MetricCard key={metric.label} {...metric} />
                ))}
            </div>
        </div>
    );
}

export function DetailCard({
    title,
    desc,
    action,
    children,
    className,
    bodyClassName,
}: {
    title: string;
    desc?: string;
    action?: ReactNode;
    children: ReactNode;
    className?: string;
    bodyClassName?: string;
}) {
    return (
        <Card className={cn('gap-0 rounded-card py-0 shadow-none', className)}>
            <div className="flex items-center gap-3.5 border-b border-border px-4 py-3">
                <div className="flex-1">
                    <div className="text-body font-semibold">{title}</div>
                    {desc && <div className="mt-0.5 text-meta text-text-muted">{desc}</div>}
                </div>
                {action}
            </div>
            <div className={cn('p-4', bodyClassName)}>{children}</div>
        </Card>
    );
}

export function PropertyGrid({ rows, columns = 2 }: { rows: [string, string][]; columns?: number }) {
    return (
        <div
            className="grid gap-x-4 gap-y-2 text-cell"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
            {rows.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                    <span className="text-text-muted">{k}</span>
                    <span className="truncate text-right font-mono text-text-2">{v}</span>
                </div>
            ))}
        </div>
    );
}
