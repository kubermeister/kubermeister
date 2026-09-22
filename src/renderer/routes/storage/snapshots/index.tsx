import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { CopyIcon } from 'lucide-react';
import type { Snapshot } from '../../../../shared/k8s/storage';
import { StatusBadge } from '@/components/data-display/status-badge';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { usePolledList } from '@/lib/resources';
import { SNAPSHOT_TONE } from '@/lib/status';

export const Route = createFileRoute('/storage/snapshots/')({ component: SnapshotsPage });

const detailPath = (snapshot: Pick<Snapshot, 'namespace' | 'name'>) =>
    `/storage/snapshots/${encodeURIComponent(snapshot.namespace)}/${encodeURIComponent(snapshot.name)}`;

const columns: ColumnDef<Snapshot>[] = [
    nameColumn<Snapshot>({ href: detailPath }),
    textColumn<Snapshot>('sourcePvc', 'Source PVC', { size: 260, mono: true }),
    textColumn<Snapshot>('restoreSize', 'Restore size', { size: 130, mono: true, numeric: true }),
    {
        id: 'ready',
        header: 'Ready',
        size: 120,
        accessorFn: (row) => row.ready,
        cell: ({ row }) => <StatusBadge tone={SNAPSHOT_TONE[row.original.ready]}>{row.original.ready}</StatusBadge>,
    },
    ageColumn<Snapshot>(),
];

function SnapshotsPage() {
    // Snapshots are a CRD a cluster need not have, so they are polled rather than watched.
    const snapshots = usePolledList('VolumeSnapshot');
    return (
        <ResourceListPage
            icon={CopyIcon}
            title="Snapshots"
            columns={columns}
            query={snapshots}
            detailPath={detailPath}
            rowProps={(snapshot) => ({ 'data-snapshot': snapshot.name })}
            selection={{ kind: 'VolumeSnapshot' }}
            testId="snapshots-table"
            emptyMessage="No snapshots found. This cluster may not have the VolumeSnapshot CRD installed."
        />
    );
}
