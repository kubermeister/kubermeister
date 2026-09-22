import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { CopyIcon } from 'lucide-react';
import type { ReplicaSetRow } from '../../../../shared/k8s/workloads';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/workloads/replicationcontrollers/')({ component: ReplicationControllersPage });

const detailPath = (rs: Pick<ReplicaSetRow, 'namespace' | 'name'>) =>
    `/workloads/replicationcontrollers/${encodeURIComponent(rs.namespace)}/${encodeURIComponent(rs.name)}`;

const columns: ColumnDef<ReplicaSetRow>[] = [
    nameColumn<ReplicaSetRow>({ href: detailPath }),
    textColumn<ReplicaSetRow>('owner', 'Owner', { size: 220, small: true }),
    textColumn<ReplicaSetRow>('desired', 'Desired', { size: 90, mono: true, numeric: true }),
    textColumn<ReplicaSetRow>('current', 'Current', { size: 90, mono: true, numeric: true }),
    textColumn<ReplicaSetRow>('ready', 'Ready', { size: 90, mono: true, numeric: true }),
    textColumn<ReplicaSetRow>('image', 'Image', { mono: true, small: true }),
    ageColumn<ReplicaSetRow>(),
];

function ReplicationControllersPage() {
    const controllers = useWatchedList('ReplicationController');
    return (
        <ResourceListPage
            icon={CopyIcon}
            title="Replication Controllers"
            columns={columns}
            query={controllers}
            detailPath={detailPath}
            rowProps={(rs) => ({ 'data-replicationcontroller': rs.name })}
            selection={{ kind: 'ReplicationController' }}
            testId="replicationcontrollers-table"
            footerNote={controllers.live ? 'live' : undefined}
        />
    );
}
