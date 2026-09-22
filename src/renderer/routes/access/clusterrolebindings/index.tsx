import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { ShieldCheckIcon } from 'lucide-react';
import type { ClusterRoleBinding } from '../../../../shared/k8s/access';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/access/clusterrolebindings/')({ component: ClusterRoleBindingsPage });

const detailPath = (binding: Pick<ClusterRoleBinding, 'name'>) =>
    `/access/clusterrolebindings/${encodeURIComponent(binding.name)}`;

const columns: ColumnDef<ClusterRoleBinding>[] = [
    nameColumn<ClusterRoleBinding>({ href: detailPath }),
    textColumn<ClusterRoleBinding>('role', 'Role', { size: 260, mono: true }),
    textColumn<ClusterRoleBinding>('subjects', 'Subjects', { size: 100, mono: true, numeric: true }),
    ageColumn<ClusterRoleBinding>(),
];

function ClusterRoleBindingsPage() {
    const bindings = useWatchedList('ClusterRoleBinding');
    return (
        <ResourceListPage
            clusterScoped
            icon={ShieldCheckIcon}
            title="Cluster Role Bindings"
            columns={columns}
            query={bindings}
            detailPath={detailPath}
            rowProps={(binding) => ({ 'data-clusterrolebinding': binding.name })}
            selection={{ kind: 'ClusterRoleBinding' }}
            testId="clusterrolebindings-table"
            footerNote={bindings.live ? 'live' : undefined}
        />
    );
}
