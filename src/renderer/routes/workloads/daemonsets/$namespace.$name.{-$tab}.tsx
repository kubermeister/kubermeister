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
import { ipcQueryKey } from '@/lib/query';
import { useResource } from '@/lib/resources';

export const Route = createFileRoute('/workloads/daemonsets/$namespace/$name/{-$tab}')({
    component: DaemonSetDetailPage,
});

function DaemonSetDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('DaemonSet', name, namespace);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Desired', String(row.desired)],
                          ['Current', String(row.current)],
                          ['Ready', String(row.ready)],
                          ['Up to date', String(row.upToDate)],
                          ['Node selector', row.nodeSelector],
                          ['Age', row.age],
                      ]),
                      podsTab({ kind: 'DaemonSet', name, namespace }),
                      workloadLogsTab({ kind: 'DaemonSet', name, namespace }),
                      eventsTab({ kind: 'DaemonSet', name, namespace }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'DaemonSet', name, namespace }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={BoxesIcon}
            eyebrow="DaemonSet"
            title={name}
            kind="DaemonSet"
            namespace={namespace}
            backTo="/workloads/daemonsets"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'DaemonSet', name, namespace })]} />
                    <RestartButton kind="DaemonSet" name={name} namespace={namespace} />
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="DaemonSet"
                        name={name}
                        namespace={namespace}
                        backTo="/workloads/daemonsets"
                    />
                </>
            }
            meta={row ? [`desired: ${row.desired}`, `ready: ${row.ready}`] : undefined}
            groups={groups}
            testId="daemonset-page"
        />
    );
}
