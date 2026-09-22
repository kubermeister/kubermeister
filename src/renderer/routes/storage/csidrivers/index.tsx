import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { PlugIcon } from 'lucide-react';
import type { CsiDriver } from '../../../../shared/k8s/csi';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, flagColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/storage/csidrivers/')({ component: CsiDriversPage });

const detailPath = (driver: Pick<CsiDriver, 'name'>) => `/storage/csidrivers/${encodeURIComponent(driver.name)}`;

const columns: ColumnDef<CsiDriver>[] = [
    nameColumn<CsiDriver>({ href: detailPath }),
    flagColumn<CsiDriver>('attachRequired', 'Attach required', 140),
    flagColumn<CsiDriver>('podInfoOnMount', 'Pod info on mount', 150),
    flagColumn<CsiDriver>('storageCapacity', 'Reports capacity', 150),
    textColumn<CsiDriver>('fsGroupPolicy', 'fsGroup policy', { size: 150 }),
    textColumn<CsiDriver>('modes', 'Modes', { small: true, muted: true }),
    ageColumn<CsiDriver>(),
];

function CsiDriversPage() {
    const drivers = useWatchedList('CSIDriver');
    return (
        <ResourceListPage
            clusterScoped
            icon={PlugIcon}
            title="CSI Drivers"
            columns={columns}
            query={drivers}
            detailPath={detailPath}
            rowProps={(driver) => ({ 'data-csidriver': driver.name })}
            selection={{ kind: 'CSIDriver' }}
            testId="csidrivers-table"
            footerNote={drivers.live ? 'live' : undefined}
        />
    );
}
