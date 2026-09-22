import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { CopyIcon } from 'lucide-react';
import type { ReplicaSetRow } from '../../../../shared/k8s/workloads';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/workloads/replicasets/')({ component: ReplicaSetsPage });

const detailPath = (rs: Pick<ReplicaSetRow, 'namespace' | 'name'>) =>
    `/workloads/replicasets/${encodeURIComponent(rs.namespace)}/${encodeURIComponent(rs.name)}`;

const columns: ColumnDef<ReplicaSetRow>[] = [
    nameColumn<ReplicaSetRow>({ href: detailPath }),
    textColumn<ReplicaSetRow>('owner', 'Owner', { size: 220, small: true }),
    textColumn<ReplicaSetRow>('desired', 'Desired', { size: 90, mono: true, numeric: true }),
    textColumn<ReplicaSetRow>('current', 'Current', { size: 90, mono: true, numeric: true }),
    textColumn<ReplicaSetRow>('ready', 'Ready', { size: 90, mono: true, numeric: true }),
    textColumn<ReplicaSetRow>('image', 'Image', { mono: true, small: true }),
    ageColumn<ReplicaSetRow>(),
];

function ReplicaSetsPage() {
    const sets = useWatchedList('ReplicaSet');
    return (
        <ResourceListPage
            icon={CopyIcon}
            title="Replica Sets"
            columns={columns}
            query={sets}
            detailPath={detailPath}
            rowProps={(rs) => ({ 'data-replicaset': rs.name })}
            selection={{ kind: 'ReplicaSet' }}
            testId="replicasets-table"
            footerNote={sets.live ? 'live' : undefined}
        />
    );
}
