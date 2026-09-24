import { createFileRoute } from '@tanstack/react-router';
import { CopyIcon } from 'lucide-react';
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

export const Route = createFileRoute('/workloads/replicationcontrollers/$namespace/$name/{-$tab}')({
    component: ReplicationControllerDetailPage,
});

function ReplicationControllerDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('ReplicationController', name, namespace);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Owner', row.owner],
                          ['Desired', String(row.desired)],
                          ['Current', String(row.current)],
                          ['Ready', String(row.ready)],
                          ['Image', row.image],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'ReplicationController', name, namespace }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'ReplicationController', name, namespace }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={CopyIcon}
            eyebrow="ReplicationController"
            title={name}
            kind="ReplicationController"
            namespace={namespace}
            backTo="/workloads/replicationcontrollers"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton
                        queryKeys={[ipcQueryKey('resources.get', { kind: 'ReplicationController', name, namespace })]}
                    />
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="ReplicationController"
                        name={name}
                        namespace={namespace}
                        backTo="/workloads/replicationcontrollers"
                    />
                </>
            }
            meta={row ? [`owner: ${row.owner}`, `ready: ${row.ready}/${row.desired}`] : undefined}
            groups={groups}
            testId="replicationcontroller-page"
        />
    );
}
