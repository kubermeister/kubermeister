import { createFileRoute } from '@tanstack/react-router';
import { TrendingUpIcon } from 'lucide-react';
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
import { AutoscalerBounds } from '@/components/workload/autoscaler-bounds';
import { DeleteResourceButton } from '@/components/templates/delete-resource-button';
import { ipcQueryKey } from '@/lib/query';
import { useResource } from '@/lib/resources';

export const Route = createFileRoute('/workloads/autoscalers/$namespace/$name/{-$tab}')({
    component: AutoscalerDetailPage,
});

function AutoscalerDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('HorizontalPodAutoscaler', name, namespace);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Reference', row.reference],
                          ['Min', String(row.min)],
                          ['Max', String(row.max)],
                          ['Replicas', String(row.replicas)],
                          ['Targets', row.targets],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'HorizontalPodAutoscaler', name, namespace }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'HorizontalPodAutoscaler', name, namespace }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={TrendingUpIcon}
            eyebrow="Autoscaler"
            title={name}
            kind="HorizontalPodAutoscaler"
            namespace={namespace}
            backTo="/workloads/autoscalers"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton
                        queryKeys={[ipcQueryKey('resources.get', { kind: 'HorizontalPodAutoscaler', name, namespace })]}
                    />
                    {row && (
                        <AutoscalerBounds
                            name={name}
                            namespace={namespace}
                            min={row.min}
                            max={row.max}
                            targetCpuPercent={row.targetCpuPercent ?? undefined}
                        />
                    )}
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="HorizontalPodAutoscaler"
                        name={name}
                        namespace={namespace}
                        backTo="/workloads/autoscalers"
                    />
                </>
            }
            meta={row ? [`reference: ${row.reference}`, `replicas: ${row.replicas}`] : undefined}
            groups={groups}
            testId="autoscaler-page"
        />
    );
}
