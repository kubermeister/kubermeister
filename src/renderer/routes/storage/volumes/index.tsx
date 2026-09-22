import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { DatabaseIcon } from 'lucide-react';
import type { Volume } from '../../../../shared/k8s/storage';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, statusColumn, textColumn } from '@/components/templates/list-columns';
import { VOLUME_TONE } from '@/lib/status';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/storage/volumes/')({ component: VolumesPage });

const detailPath = (volume: Pick<Volume, 'name'>) => `/storage/volumes/${encodeURIComponent(volume.name)}`;

const columns: ColumnDef<Volume>[] = [
    nameColumn<Volume>({ href: detailPath }),
    textColumn<Volume>('capacity', 'Capacity', { size: 90, mono: true, numeric: true }),
    textColumn<Volume>('accessModes', 'Access modes', { size: 110, mono: true }),
    textColumn<Volume>('reclaimPolicy', 'Reclaim policy', { size: 110 }),
    statusColumn<Volume, Volume['status']>(VOLUME_TONE),
    textColumn<Volume>('claim', 'Claim', { size: 220, mono: true }),
    textColumn<Volume>('storageClass', 'Storage class', { size: 150 }),
    ageColumn<Volume>(),
];

function VolumesPage() {
    const volumes = useWatchedList('PersistentVolume');
    return (
        <ResourceListPage
            clusterScoped
            icon={DatabaseIcon}
            title="Volumes"
            columns={columns}
            query={volumes}
            detailPath={detailPath}
            rowProps={(volume) => ({ 'data-volume': volume.name })}
            selection={{ kind: 'PersistentVolume' }}
            testId="volumes-table"
            footerNote={volumes.live ? 'live' : undefined}
        />
    );
}
