import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { LayersIcon } from 'lucide-react';
import type { StorageClass } from '../../../../shared/k8s/storage';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { Badge } from '@/components/ui/badge';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/storage/storageclasses/')({ component: StorageClassesPage });

const detailPath = (storageClass: Pick<StorageClass, 'name'>) =>
    `/storage/storageclasses/${encodeURIComponent(storageClass.name)}`;

const columns: ColumnDef<StorageClass>[] = [
    nameColumn<StorageClass>({ href: detailPath }),
    textColumn<StorageClass>('provisioner', 'Provisioner', { size: 240, mono: true }),
    textColumn<StorageClass>('reclaimPolicy', 'Reclaim policy', { size: 120 }),
    textColumn<StorageClass>('volumeBinding', 'Volume binding', { size: 190 }),
    {
        id: 'isDefault',
        header: 'Default',
        size: 90,
        accessorFn: (row) => row.isDefault,
        cell: ({ row }) =>
            row.original.isDefault ? (
                <Badge variant="accent" className="rounded-sm">
                    default
                </Badge>
            ) : (
                <span className="font-mono text-text-muted tabular-nums">—</span>
            ),
    },
    ageColumn<StorageClass>(),
];

function StorageClassesPage() {
    const classes = useWatchedList('StorageClass');
    return (
        <ResourceListPage
            clusterScoped
            icon={LayersIcon}
            title="Storage Classes"
            columns={columns}
            query={classes}
            detailPath={detailPath}
            rowProps={(storageClass) => ({ 'data-storageclass': storageClass.name })}
            selection={{ kind: 'StorageClass' }}
            testId="storageclasses-table"
            footerNote={classes.live ? 'live' : undefined}
        />
    );
}
