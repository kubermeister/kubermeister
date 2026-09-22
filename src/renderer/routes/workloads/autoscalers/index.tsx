import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { TrendingUpIcon } from 'lucide-react';
import type { Autoscaler } from '../../../../shared/k8s/workloads';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/workloads/autoscalers/')({ component: AutoscalersPage });

const detailPath = (autoscaler: Pick<Autoscaler, 'namespace' | 'name'>) =>
    `/workloads/autoscalers/${encodeURIComponent(autoscaler.namespace)}/${encodeURIComponent(autoscaler.name)}`;

const columns: ColumnDef<Autoscaler>[] = [
    nameColumn<Autoscaler>({ href: detailPath }),
    textColumn<Autoscaler>('reference', 'Reference', { size: 250, mono: true, small: true }),
    textColumn<Autoscaler>('min', 'Min', { size: 70, mono: true, muted: true, numeric: true }),
    textColumn<Autoscaler>('max', 'Max', { size: 70, mono: true, muted: true, numeric: true }),
    textColumn<Autoscaler>('replicas', 'Replicas', { size: 90, mono: true, numeric: true }),
    textColumn<Autoscaler>('targets', 'Targets', { size: 130, mono: true, numeric: true }),
    ageColumn<Autoscaler>(),
];

function AutoscalersPage() {
    const autoscalers = useWatchedList('HorizontalPodAutoscaler');
    return (
        <ResourceListPage
            icon={TrendingUpIcon}
            title="Autoscalers"
            columns={columns}
            query={autoscalers}
            detailPath={detailPath}
            rowProps={(autoscaler) => ({ 'data-autoscaler': autoscaler.name })}
            selection={{ kind: 'HorizontalPodAutoscaler' }}
            testId="autoscalers-table"
            footerNote={autoscalers.live ? 'live' : undefined}
        />
    );
}
