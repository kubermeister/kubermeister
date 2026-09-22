import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { LockIcon } from 'lucide-react';
import type { Secret } from '../../../../shared/k8s/workloads';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/workloads/secrets/')({ component: SecretsPage });

const detailPath = (secret: Pick<Secret, 'namespace' | 'name'>) =>
    `/workloads/secrets/${encodeURIComponent(secret.namespace)}/${encodeURIComponent(secret.name)}`;

const columns: ColumnDef<Secret>[] = [
    nameColumn<Secret>({ icon: LockIcon, href: detailPath }),
    textColumn<Secret>('type', 'Type', { size: 320, mono: true, small: true }),
    textColumn<Secret>('keys', 'Keys', { size: 90, mono: true, numeric: true }),
    ageColumn<Secret>(),
];

function SecretsPage() {
    const secrets = useWatchedList('Secret');
    return (
        <ResourceListPage
            icon={LockIcon}
            title="Secrets"
            columns={columns}
            query={secrets}
            detailPath={detailPath}
            rowProps={(secret) => ({ 'data-secret': secret.name })}
            selection={{ kind: 'Secret' }}
            testId="secrets-table"
            footerNote={secrets.live ? 'live' : undefined}
        />
    );
}
