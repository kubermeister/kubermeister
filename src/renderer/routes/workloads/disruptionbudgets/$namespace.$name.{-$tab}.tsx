import { createFileRoute } from '@tanstack/react-router';
import { ShieldCheckIcon } from 'lucide-react';
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
import { DISRUPTION_TONE } from '@/lib/status';

export const Route = createFileRoute('/workloads/disruptionbudgets/$namespace/$name/{-$tab}')({
    component: DisruptionBudgetDetailPage,
});

function DisruptionBudgetDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('PodDisruptionBudget', name, namespace);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Policy', row.policy],
                          ['Healthy now', String(row.currentHealthy)],
                          ['Healthy wanted', String(row.desiredHealthy)],
                          ['Disruptions allowed', String(row.disruptionsAllowed)],
                          ['Selector', row.selector],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'PodDisruptionBudget', name, namespace }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'PodDisruptionBudget', name, namespace }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={ShieldCheckIcon}
            eyebrow="PodDisruptionBudget"
            title={name}
            kind="PodDisruptionBudget"
            namespace={namespace}
            backTo="/workloads/disruptionbudgets"
            query={query}
            found={!!row}
            status={row ? { label: row.status, tone: DISRUPTION_TONE[row.status] } : undefined}
            actions={
                <>
                    <RefreshButton
                        queryKeys={[ipcQueryKey('resources.get', { kind: 'PodDisruptionBudget', name, namespace })]}
                    />
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="PodDisruptionBudget"
                        name={name}
                        namespace={namespace}
                        backTo="/workloads/disruptionbudgets"
                    />
                </>
            }
            meta={row ? [row.policy, `allowed: ${row.disruptionsAllowed}`] : undefined}
            groups={groups}
            testId="disruptionbudget-page"
        />
    );
}
