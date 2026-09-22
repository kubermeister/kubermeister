import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { ShieldIcon } from 'lucide-react';
import type { Role } from '../../../../shared/k8s/access';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/access/roles/')({ component: RolesPage });

const detailPath = (role: Pick<Role, 'namespace' | 'name'>) =>
    `/access/roles/${encodeURIComponent(role.namespace)}/${encodeURIComponent(role.name)}`;

const columns: ColumnDef<Role>[] = [
    nameColumn<Role>({ href: detailPath }),
    textColumn<Role>('namespace', 'Namespace', { size: 180 }),
    textColumn<Role>('rules', 'Rules', { size: 100, mono: true, numeric: true }),
    ageColumn<Role>(),
];

function RolesPage() {
    const roles = useWatchedList('Role');
    return (
        <ResourceListPage
            icon={ShieldIcon}
            title="Roles"
            columns={columns}
            query={roles}
            detailPath={detailPath}
            rowProps={(role) => ({ 'data-role': role.name })}
            selection={{ kind: 'Role' }}
            testId="roles-table"
            footerNote={roles.live ? 'live' : undefined}
        />
    );
}
