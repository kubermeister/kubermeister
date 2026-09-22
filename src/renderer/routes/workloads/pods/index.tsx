import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { BoxIcon } from 'lucide-react';
import type { Pod } from '../../../../shared/k8s/pods';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ageColumn, meterColumn, nameColumn, statusColumn } from '@/components/templates/list-columns';
import { POD_TONE } from '@/lib/status';
import { cn } from '@/lib/utils';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/workloads/pods/')({ component: PodsPage });

/** Usage as a percentage of the limit, or null when the pod declares no limit to measure against. */
export const pct = (used: number, limit?: number) => (limit ? Math.min(100, Math.round((used / limit) * 100)) : null);

const detailPath = (pod: Pick<Pod, 'namespace' | 'name'>) =>
    `/workloads/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}`;

const READY_TONE: Partial<Record<Pod['status'], string>> = { Running: 'text-ok', Pending: 'text-warn' };

const columns: ColumnDef<Pod>[] = [
    nameColumn<Pod>({ href: detailPath }),
    meterColumn<Pod>('cpu', 'CPU', (p) => pct(p.cpu, p.cpuLimit), {
        label: (p) => `${p.cpu}m`,
        labelClassName: 'w-10',
    }),
    meterColumn<Pod>('mem', 'Memory', (p) => pct(p.mem, p.memLimit), {
        label: (p) => `${p.mem}Mi`,
        labelClassName: 'w-11',
    }),
    {
        id: 'ready',
        header: 'Ready',
        size: 70,
        accessorFn: (row) => row.ready,
        cell: ({ row }) => (
            <span className={cn('font-mono tabular-nums', READY_TONE[row.original.status] ?? 'text-danger')}>
                {row.original.ready}
            </span>
        ),
    },
    statusColumn<Pod, Pod['status']>(POD_TONE, { size: 110 }),
    {
        id: 'restarts',
        header: 'Restarts',
        size: 80,
        accessorFn: (row) => row.restarts,
        cell: ({ row }) => (
            <span className={cn('font-mono tabular-nums', row.original.restarts > 0 ? 'text-warn' : 'text-text-muted')}>
                {row.original.restarts}
            </span>
        ),
    },
    ageColumn<Pod>(),
];

/**
 * A cluster-wide pod list is a wall of names. Grouping turns it into the two questions people
 * actually ask of it: what is on this node, and what belongs to this workload.
 */
const GROUPS = {
    none: undefined,
    node: (pod: Pod) => pod.node,
    owner: (pod: Pod) => pod.owner,
} satisfies Record<string, ((pod: Pod) => string) | undefined>;

type GroupKey = keyof typeof GROUPS;
const GROUP_LABEL: Record<GroupKey, string> = { none: 'No grouping', node: 'By node', owner: 'By owner' };

function PodsPage() {
    const pods = useWatchedList('Pod');
    const [group, setGroup] = useState<GroupKey>('none');
    const groupBy = GROUPS[group];
    // Rows of one group must sit together, so grouping sorts by its own key first.
    const rows = groupBy ? [...(pods.data ?? [])].sort((a, b) => groupBy(a).localeCompare(groupBy(b))) : pods.data;
    return (
        <div className="h-full" data-testid="pods-page" data-live={String(pods.live)}>
            <ResourceListPage
                icon={BoxIcon}
                title="Pods"
                columns={columns}
                query={{ ...pods, data: rows }}
                detailPath={detailPath}
                groupBy={groupBy}
                toolbar={
                    <Select value={group} onValueChange={(value) => setGroup(value as GroupKey)}>
                        <SelectTrigger className="h-8 w-40 text-body" aria-label="Group pods">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {(Object.keys(GROUPS) as GroupKey[]).map((key) => (
                                <SelectItem key={key} value={key}>
                                    {GROUP_LABEL[key]}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                }
                rowProps={(pod) => ({ 'data-pod': pod.name })}
                selection={{ kind: 'Pod' }}
                testId="pods-table"
                footerNote={pods.live ? 'live' : undefined}
            />
        </div>
    );
}
