import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { ShieldIcon } from 'lucide-react';
import type { NetworkPolicy } from '../../../../shared/k8s/network';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/network/networkpolicies/')({ component: NetworkPoliciesPage });

const detailPath = (policy: Pick<NetworkPolicy, 'namespace' | 'name'>) =>
    `/network/networkpolicies/${encodeURIComponent(policy.namespace)}/${encodeURIComponent(policy.name)}`;

const columns: ColumnDef<NetworkPolicy>[] = [
    nameColumn<NetworkPolicy>({ href: detailPath }),
    textColumn<NetworkPolicy>('podSelector', 'Pod selector', { size: 260, mono: true, small: true }),
    textColumn<NetworkPolicy>('policyTypes', 'Policy types'),
    ageColumn<NetworkPolicy>(),
];

function NetworkPoliciesPage() {
    const policies = useWatchedList('NetworkPolicy');
    return (
        <ResourceListPage
            icon={ShieldIcon}
            title="Network Policies"
            columns={columns}
            query={policies}
            detailPath={detailPath}
            rowProps={(policy) => ({ 'data-networkpolicy': policy.name })}
            selection={{ kind: 'NetworkPolicy' }}
            testId="networkpolicies-table"
            footerNote={policies.live ? 'live' : undefined}
        />
    );
}
