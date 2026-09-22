import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { ShieldCheckIcon } from 'lucide-react';
import type { PodDisruptionBudget } from '../../../../shared/k8s/policy';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, statusColumn, textColumn } from '@/components/templates/list-columns';
import { DISRUPTION_TONE } from '@/lib/status';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/workloads/disruptionbudgets/')({ component: DisruptionBudgetsPage });

const detailPath = (pdb: Pick<PodDisruptionBudget, 'namespace' | 'name'>) =>
    `/workloads/disruptionbudgets/${encodeURIComponent(pdb.namespace)}/${encodeURIComponent(pdb.name)}`;

const columns: ColumnDef<PodDisruptionBudget>[] = [
    nameColumn<PodDisruptionBudget>({ href: detailPath }),
    textColumn<PodDisruptionBudget>('policy', 'Policy', { size: 170 }),
    textColumn<PodDisruptionBudget>('currentHealthy', 'Healthy', { size: 90, mono: true, numeric: true }),
    textColumn<PodDisruptionBudget>('desiredHealthy', 'Desired', { size: 90, mono: true, numeric: true }),
    textColumn<PodDisruptionBudget>('disruptionsAllowed', 'Allowed', { size: 90, mono: true, numeric: true }),
    textColumn<PodDisruptionBudget>('selector', 'Selector', { mono: true, small: true }),
    statusColumn<PodDisruptionBudget, PodDisruptionBudget['status']>(DISRUPTION_TONE),
    ageColumn<PodDisruptionBudget>(),
];

function DisruptionBudgetsPage() {
    const budgets = useWatchedList('PodDisruptionBudget');
    return (
        <ResourceListPage
            icon={ShieldCheckIcon}
            title="Disruption Budgets"
            columns={columns}
            query={budgets}
            detailPath={detailPath}
            rowProps={(pdb) => ({ 'data-disruptionbudget': pdb.name })}
            selection={{ kind: 'PodDisruptionBudget' }}
            testId="disruptionbudgets-table"
            footerNote={budgets.live ? 'live' : undefined}
        />
    );
}
