import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { PlayIcon } from 'lucide-react';
import type { Job } from '../../../../shared/k8s/workloads';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, readyRatioColumn, statusColumn, textColumn } from '@/components/templates/list-columns';
import { JOB_TONE } from '@/lib/status';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/workloads/jobs/')({ component: JobsPage });

const detailPath = (job: Pick<Job, 'namespace' | 'name'>) =>
    `/workloads/jobs/${encodeURIComponent(job.namespace)}/${encodeURIComponent(job.name)}`;

const columns: ColumnDef<Job>[] = [
    nameColumn<Job>({ href: detailPath }),
    readyRatioColumn<Job>('completions', 'Completions', 120),
    textColumn<Job>('duration', 'Duration', { size: 110, mono: true, muted: true, numeric: true }),
    statusColumn<Job, Job['status']>(JOB_TONE),
    ageColumn<Job>(),
];

function JobsPage() {
    const jobs = useWatchedList('Job');
    return (
        <ResourceListPage
            icon={PlayIcon}
            title="Jobs"
            columns={columns}
            query={jobs}
            detailPath={detailPath}
            rowProps={(job) => ({ 'data-job': job.name })}
            selection={{ kind: 'Job' }}
            testId="jobs-table"
            footerNote={jobs.live ? 'live' : undefined}
        />
    );
}
