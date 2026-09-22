import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { ShieldIcon } from 'lucide-react';
import type { ClusterRole } from '../../../../shared/k8s/access';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { Badge } from '@/components/ui/badge';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/access/clusterroles/')({ component: ClusterRolesPage });

const detailPath = (role: Pick<ClusterRole, 'name'>) => `/access/clusterroles/${encodeURIComponent(role.name)}`;

const columns: ColumnDef<ClusterRole>[] = [
    nameColumn<ClusterRole>({ href: detailPath }),
    textColumn<ClusterRole>('rules', 'Rules', { size: 110, mono: true, numeric: true }),
    {
        id: 'aggregated',
        header: 'Aggregated',
        size: 130,
        cell: ({ row }) =>
            row.original.aggregated ? (
                <Badge variant="neutral" className="rounded-sm">
                    aggregated
                </Badge>
            ) : (
                <span className="font-mono text-text-muted tabular-nums">—</span>
            ),
    },
    ageColumn<ClusterRole>(),
];

function ClusterRolesPage() {
    const roles = useWatchedList('ClusterRole');
    return (
        <ResourceListPage
            clusterScoped
            icon={ShieldIcon}
            title="Cluster Roles"
            columns={columns}
            query={roles}
            detailPath={detailPath}
            rowProps={(role) => ({ 'data-clusterrole': role.name })}
            selection={{ kind: 'ClusterRole' }}
            testId="clusterroles-table"
            footerNote={roles.live ? 'live' : undefined}
        />
    );
}
