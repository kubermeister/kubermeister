import { createFileRoute } from '@tanstack/react-router';
import { BoxesIcon } from 'lucide-react';
import { RefreshButton } from '@/components/refresh-button';
import {
    eventsTab,
    labelsTab,
    overviewTab,
    ResourceDetail,
    type DetailTabGroup,
} from '@/components/templates/resource-detail';
import { podsTab } from '@/components/templates/owned-pods';
import { workloadLogsTab } from '@/components/workload/workload-logs-tab';
import { manifestTab } from '@/components/templates/manifest-panel';
import { EditResourceButton } from '@/components/templates/edit-resource-button';
import { DeleteResourceButton } from '@/components/templates/delete-resource-button';
import { RestartButton } from '@/components/templates/restart-button';
import { ScaleButton } from '@/components/templates/scale-control';
import { ipcQueryKey } from '@/lib/query';
import { useResource } from '@/lib/resources';

export const Route = createFileRoute('/workloads/statefulsets/$namespace/$name/{-$tab}')({
    component: StatefulSetDetailPage,
});

function StatefulSetDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('StatefulSet', name, namespace);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Ready', row.ready],
                          ['Service', row.service],
                          ['Image', row.image],
                          ['Age', row.age],
                      ]),
                      podsTab({ kind: 'StatefulSet', name, namespace }),
                      workloadLogsTab({ kind: 'StatefulSet', name, namespace }),
                      eventsTab({ kind: 'StatefulSet', name, namespace }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'StatefulSet', name, namespace }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={BoxesIcon}
            eyebrow="StatefulSet"
            title={name}
            kind="StatefulSet"
            namespace={namespace}
            backTo="/workloads/statefulsets"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton
                        queryKeys={[ipcQueryKey('resources.get', { kind: 'StatefulSet', name, namespace })]}
                    />
                    {row && (
                        <ScaleButton kind="StatefulSet" name={name} namespace={namespace} replicas={row.replicas} />
                    )}
                    <RestartButton kind="StatefulSet" name={name} namespace={namespace} />
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="StatefulSet"
                        name={name}
                        namespace={namespace}
                        backTo="/workloads/statefulsets"
                    />
                </>
            }
            meta={row ? [`ready: ${row.ready}`, `service: ${row.service}`] : undefined}
            groups={groups}
            testId="statefulset-page"
        />
    );
}
