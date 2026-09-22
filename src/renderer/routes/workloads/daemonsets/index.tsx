import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { BoxesIcon } from 'lucide-react';
import type { DaemonSet } from '../../../../shared/k8s/workloads';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/workloads/daemonsets/')({ component: DaemonSetsPage });

const detailPath = (d: Pick<DaemonSet, 'namespace' | 'name'>) =>
    `/workloads/daemonsets/${encodeURIComponent(d.namespace)}/${encodeURIComponent(d.name)}`;

const columns: ColumnDef<DaemonSet>[] = [
    nameColumn<DaemonSet>({ href: detailPath }),
    textColumn<DaemonSet>('desired', 'Desired', { size: 90, mono: true, numeric: true }),
    textColumn<DaemonSet>('current', 'Current', { size: 90, mono: true, numeric: true }),
    textColumn<DaemonSet>('ready', 'Ready', { size: 90, mono: true, numeric: true }),
    textColumn<DaemonSet>('upToDate', 'Up-to-date', { size: 100, mono: true, numeric: true }),
    textColumn<DaemonSet>('nodeSelector', 'Node selector', { mono: true, small: true }),
    ageColumn<DaemonSet>(),
];

function DaemonSetsPage() {
    const sets = useWatchedList('DaemonSet');
    return (
        <ResourceListPage
            icon={BoxesIcon}
            title="Daemon Sets"
            columns={columns}
            query={sets}
            detailPath={detailPath}
            rowProps={(d) => ({ 'data-daemonset': d.name })}
            selection={{ kind: 'DaemonSet' }}
            testId="daemonsets-table"
            footerNote={sets.live ? 'live' : undefined}
        />
    );
}
