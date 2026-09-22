import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { KeyRoundIcon } from 'lucide-react';
import type { Lease } from '../../../../shared/k8s/policy';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/overview/leases/')({ component: LeasesPage });

const detailPath = (lease: Pick<Lease, 'namespace' | 'name'>) =>
    `/overview/leases/${encodeURIComponent(lease.namespace)}/${encodeURIComponent(lease.name)}`;

const columns: ColumnDef<Lease>[] = [
    nameColumn<Lease>({ href: detailPath }),
    textColumn<Lease>('holder', 'Holder', { mono: true, small: true }),
    textColumn<Lease>('duration', 'Duration', { size: 110, mono: true, numeric: true }),
    textColumn<Lease>('renewed', 'Renewed', { size: 130, muted: true }),
    ageColumn<Lease>(),
];

function LeasesPage() {
    const leases = useWatchedList('Lease');
    return (
        <ResourceListPage
            icon={KeyRoundIcon}
            title="Leases"
            columns={columns}
            query={leases}
            detailPath={detailPath}
            rowProps={(lease) => ({ 'data-lease': lease.name })}
            selection={{ kind: 'Lease' }}
            testId="leases-table"
            footerNote={leases.live ? 'live' : undefined}
        />
    );
}
