import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { GaugeIcon } from 'lucide-react';
import type { CsiCapacity } from '../../../../shared/k8s/csi';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/storage/capacity/')({ component: StorageCapacityPage });

const detailPath = (capacity: Pick<CsiCapacity, 'namespace' | 'name'>) =>
    `/storage/capacity/${encodeURIComponent(capacity.namespace)}/${encodeURIComponent(capacity.name)}`;

const columns: ColumnDef<CsiCapacity>[] = [
    nameColumn<CsiCapacity>({ href: detailPath }),
    textColumn<CsiCapacity>('storageClass', 'Storage class', { size: 180 }),
    textColumn<CsiCapacity>('capacity', 'Capacity', { size: 120, mono: true, numeric: true }),
    textColumn<CsiCapacity>('maximumVolumeSize', 'Max volume', { size: 130, mono: true, numeric: true }),
    textColumn<CsiCapacity>('topology', 'Topology', { mono: true, small: true, muted: true }),
    ageColumn<CsiCapacity>(),
];

function StorageCapacityPage() {
    const capacities = useWatchedList('CSIStorageCapacity');
    return (
        <ResourceListPage
            icon={GaugeIcon}
            title="Storage Capacity"
            nounPlural="CSI Storage Capacity objects"
            columns={columns}
            query={capacities}
            detailPath={detailPath}
            rowProps={(capacity) => ({ 'data-capacity': capacity.name })}
            selection={{ kind: 'CSIStorageCapacity' }}
            testId="capacity-table"
            footerNote={capacities.live ? 'live' : undefined}
        />
    );
}
