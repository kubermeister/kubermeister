import { createFileRoute } from '@tanstack/react-router';
import { ScaleIcon } from 'lucide-react';
import { RefreshButton } from '@/components/refresh-button';
import {
    eventsTab,
    labelsTab,
    overviewTab,
    ResourceDetail,
    type DetailTabGroup,
} from '@/components/templates/resource-detail';
import { manifestTab } from '@/components/templates/manifest-panel';
import { EditResourceButton } from '@/components/templates/edit-resource-button';
import { DeleteResourceButton } from '@/components/templates/delete-resource-button';
import { ipcQueryKey } from '@/lib/query';
import { useResource } from '@/lib/resources';

export const Route = createFileRoute('/addons/admissionpolicies_/$name/{-$tab}')({
    component: AdmissionPolicyDetailPage,
});

function AdmissionPolicyDetailPage() {
    const { name } = Route.useParams();
    const query = useResource('ValidatingAdmissionPolicy', name);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Validations', String(row.validations)],
                          ['Matches', row.matches],
                          ['Failure policy', row.failurePolicy],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'ValidatingAdmissionPolicy', name }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'ValidatingAdmissionPolicy', name }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={ScaleIcon}
            eyebrow="ValidatingAdmissionPolicy"
            title={name}
            kind="ValidatingAdmissionPolicy"
            backTo="/addons/admissionpolicies"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton
                        queryKeys={[ipcQueryKey('resources.get', { kind: 'ValidatingAdmissionPolicy', name })]}
                    />
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="ValidatingAdmissionPolicy"
                        name={name}
                        backTo="/addons/admissionpolicies"
                    />
                </>
            }
            meta={row ? [`validations: ${row.validations}`] : undefined}
            groups={groups}
            testId="admissionpolicy-page"
        />
    );
}
