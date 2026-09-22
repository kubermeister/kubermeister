import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { TimerIcon } from 'lucide-react';
import type { CronJob } from '../../../../shared/k8s/workloads';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { cn } from '@/lib/utils';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/workloads/cronjobs/')({ component: CronJobsPage });

const detailPath = (cronJob: Pick<CronJob, 'namespace' | 'name'>) =>
    `/workloads/cronjobs/${encodeURIComponent(cronJob.namespace)}/${encodeURIComponent(cronJob.name)}`;

const columns: ColumnDef<CronJob>[] = [
    nameColumn<CronJob>({ href: detailPath }),
    textColumn<CronJob>('schedule', 'Schedule', { size: 140, mono: true, small: true }),
    {
        id: 'suspend',
        header: 'Suspend',
        size: 90,
        accessorFn: (row) => row.suspend,
        cell: ({ row }) => (
            <span className={row.original.suspend ? 'text-warn' : 'text-text-muted'}>
                {row.original.suspend ? 'true' : 'false'}
            </span>
        ),
    },
    {
        id: 'active',
        header: 'Active',
        size: 80,
        accessorFn: (row) => row.active,
        cell: ({ row }) => (
            <span
                className={cn('font-mono tabular-nums', row.original.active > 0 ? 'text-primary' : 'text-text-muted')}
            >
                {row.original.active}
            </span>
        ),
    },
    textColumn<CronJob>('lastSchedule', 'Last schedule', { size: 130, mono: true, muted: true, numeric: true }),
    ageColumn<CronJob>(),
];

function CronJobsPage() {
    const cronJobs = useWatchedList('CronJob');
    return (
        <ResourceListPage
            icon={TimerIcon}
            title="Cron Jobs"
            columns={columns}
            query={cronJobs}
            detailPath={detailPath}
            rowProps={(cronJob) => ({ 'data-cronjob': cronJob.name })}
            selection={{ kind: 'CronJob' }}
            testId="cronjobs-table"
            footerNote={cronJobs.live ? 'live' : undefined}
        />
    );
}
