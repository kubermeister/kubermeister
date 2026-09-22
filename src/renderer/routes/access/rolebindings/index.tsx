import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { ShieldCheckIcon } from 'lucide-react';
import type { RoleBinding } from '../../../../shared/k8s/access';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/access/rolebindings/')({ component: RoleBindingsPage });

const detailPath = (binding: Pick<RoleBinding, 'namespace' | 'name'>) =>
    `/access/rolebindings/${encodeURIComponent(binding.namespace)}/${encodeURIComponent(binding.name)}`;

const columns: ColumnDef<RoleBinding>[] = [
    nameColumn<RoleBinding>({ href: detailPath }),
    textColumn<RoleBinding>('role', 'Role', { size: 220, mono: true }),
    textColumn<RoleBinding>('subjects', 'Subjects', { size: 100, mono: true, numeric: true }),
    textColumn<RoleBinding>('namespace', 'Namespace', { size: 180 }),
    ageColumn<RoleBinding>(),
];

function RoleBindingsPage() {
    const bindings = useWatchedList('RoleBinding');
    return (
        <ResourceListPage
            icon={ShieldCheckIcon}
            title="Role Bindings"
            columns={columns}
            query={bindings}
            detailPath={detailPath}
            rowProps={(binding) => ({ 'data-rolebinding': binding.name })}
            selection={{ kind: 'RoleBinding' }}
            testId="rolebindings-table"
            footerNote={bindings.live ? 'live' : undefined}
        />
    );
}
