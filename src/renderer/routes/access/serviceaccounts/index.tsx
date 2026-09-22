import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { UserIcon } from 'lucide-react';
import type { ServiceAccount } from '../../../../shared/k8s/access';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/access/serviceaccounts/')({ component: ServiceAccountsPage });

const detailPath = (account: Pick<ServiceAccount, 'namespace' | 'name'>) =>
    `/access/serviceaccounts/${encodeURIComponent(account.namespace)}/${encodeURIComponent(account.name)}`;

const columns: ColumnDef<ServiceAccount>[] = [
    nameColumn<ServiceAccount>({ href: detailPath }),
    textColumn<ServiceAccount>('secrets', 'Secrets', { size: 100, mono: true, numeric: true }),
    textColumn<ServiceAccount>('namespace', 'Namespace', { size: 180 }),
    ageColumn<ServiceAccount>(),
];

function ServiceAccountsPage() {
    const accounts = useWatchedList('ServiceAccount');
    return (
        <ResourceListPage
            icon={UserIcon}
            title="Service Accounts"
            columns={columns}
            query={accounts}
            detailPath={detailPath}
            rowProps={(account) => ({ 'data-serviceaccount': account.name })}
            selection={{ kind: 'ServiceAccount' }}
            testId="serviceaccounts-table"
            footerNote={accounts.live ? 'live' : undefined}
        />
    );
}
