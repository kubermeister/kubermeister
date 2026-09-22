import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { ScaleIcon } from 'lucide-react';
import type { AdmissionPolicy } from '../../../../shared/k8s/admission';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/addons/admissionpolicies/')({ component: AdmissionPoliciesPage });

const detailPath = (policy: Pick<AdmissionPolicy, 'name'>) =>
    `/addons/admissionpolicies/${encodeURIComponent(policy.name)}`;

const columns: ColumnDef<AdmissionPolicy>[] = [
    nameColumn<AdmissionPolicy>({ href: detailPath }),
    textColumn<AdmissionPolicy>('validations', 'Validations', { size: 110, mono: true, numeric: true }),
    textColumn<AdmissionPolicy>('matches', 'Matches', { mono: true, small: true }),
    textColumn<AdmissionPolicy>('failurePolicy', 'Failure policy', { size: 140 }),
    ageColumn<AdmissionPolicy>(),
];

function AdmissionPoliciesPage() {
    const policies = useWatchedList('ValidatingAdmissionPolicy');
    return (
        <ResourceListPage
            clusterScoped
            icon={ScaleIcon}
            title="Admission Policies"
            nounPlural="Validating Admission Policies"
            columns={columns}
            query={policies}
            detailPath={detailPath}
            rowProps={(policy) => ({ 'data-admissionpolicy': policy.name })}
            selection={{ kind: 'ValidatingAdmissionPolicy' }}
            testId="admissionpolicies-table"
            footerNote={policies.live ? 'live' : undefined}
        />
    );
}
