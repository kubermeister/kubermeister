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

export const Route = createFileRoute('/workloads/replicasets/$namespace/$name/{-$tab}')({
    component: ReplicaSetDetailPage,
});

function ReplicaSetDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('ReplicaSet', name, namespace);
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
                      eventsTab({ kind: 'ReplicaSet', name, namespace }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'ReplicaSet', name, namespace }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={CopyIcon}
            eyebrow="ReplicaSet"
            title={name}
            kind="ReplicaSet"
            namespace={namespace}
            backTo="/workloads/replicasets"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton
                        queryKeys={[ipcQueryKey('resources.get', { kind: 'ReplicaSet', name, namespace })]}
                    />
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="ReplicaSet"
                        name={name}
                        namespace={namespace}
                        backTo="/workloads/replicasets"
                    />
                </>
            }
            meta={row ? [`owner: ${row.owner}`, `ready: ${row.ready}/${row.desired}`] : undefined}
            groups={groups}
            testId="replicaset-page"
        />
    );
}
