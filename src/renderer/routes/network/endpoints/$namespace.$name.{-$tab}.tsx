import { createFileRoute } from '@tanstack/react-router';
import { WaypointsIcon } from 'lucide-react';
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

export const Route = createFileRoute('/network/endpoints/$namespace/$name/{-$tab}')({ component: EndpointsDetailPage });

function EndpointsDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('Endpoints', name, namespace);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Endpoints', row.endpoints],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'Endpoints', name, namespace }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'Endpoints', name, namespace }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={WaypointsIcon}
            eyebrow="Endpoints"
            title={name}
            kind="Endpoints"
            namespace={namespace}
            backTo="/network/endpoints"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'Endpoints', name, namespace })]} />
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="Endpoints"
                        name={name}
                        namespace={namespace}
                        backTo="/network/endpoints"
                    />
                </>
            }
            meta={row ? [`namespace: ${row.namespace}`, `endpoints: ${row.endpoints}`] : undefined}
            groups={groups}
            testId="endpoints-page"
        />
    );
}
