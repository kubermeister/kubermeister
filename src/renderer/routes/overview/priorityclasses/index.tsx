import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowUpNarrowWideIcon } from 'lucide-react';
import type { PriorityClass } from '../../../../shared/k8s/policy';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { Badge } from '@/components/ui/badge';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/overview/priorityclasses/')({ component: PriorityClassesPage });

const detailPath = (priorityClass: Pick<PriorityClass, 'name'>) =>
    `/overview/priorityclasses/${encodeURIComponent(priorityClass.name)}`;

const columns: ColumnDef<PriorityClass>[] = [
    nameColumn<PriorityClass>({ href: detailPath }),
    textColumn<PriorityClass>('value', 'Value', { size: 110, mono: true, numeric: true }),
    textColumn<PriorityClass>('preemption', 'Preemption', { size: 190 }),
    {
        id: 'globalDefault',
        header: 'Default',
        size: 90,
        accessorFn: (row) => row.globalDefault,
        cell: ({ row }) =>
            row.original.globalDefault ? (
                <Badge variant="accent" className="rounded-sm">
                    default
                </Badge>
            ) : (
                <span className="font-mono text-text-muted tabular-nums">—</span>
            ),
    },
    textColumn<PriorityClass>('description', 'Description', { small: true, muted: true }),
    ageColumn<PriorityClass>(),
];

function PriorityClassesPage() {
    const classes = useWatchedList('PriorityClass');
    return (
        <ResourceListPage
            clusterScoped
            icon={ArrowUpNarrowWideIcon}
            title="Priority Classes"
            columns={columns}
            query={classes}
            detailPath={detailPath}
            rowProps={(priorityClass) => ({ 'data-priorityclass': priorityClass.name })}
            selection={{ kind: 'PriorityClass' }}
            testId="priorityclasses-table"
            footerNote={classes.live ? 'live' : undefined}
        />
    );
}
