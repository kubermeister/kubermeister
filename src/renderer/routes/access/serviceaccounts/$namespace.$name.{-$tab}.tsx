import { createFileRoute } from '@tanstack/react-router';
import { UserIcon } from 'lucide-react';
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

export const Route = createFileRoute('/access/serviceaccounts/$namespace/$name/{-$tab}')({
    component: ServiceAccountDetailPage,
});

function ServiceAccountDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('ServiceAccount', name, namespace);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Namespace', row.namespace],
                          ['Secrets', String(row.secrets)],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'ServiceAccount', name, namespace }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'ServiceAccount', name, namespace }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={UserIcon}
            eyebrow="ServiceAccount"
            title={name}
            kind="ServiceAccount"
            namespace={namespace}
            backTo="/access/serviceaccounts"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton
                        queryKeys={[ipcQueryKey('resources.get', { kind: 'ServiceAccount', name, namespace })]}
                    />
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="ServiceAccount"
                        name={name}
                        namespace={namespace}
                        backTo="/access/serviceaccounts"
                    />
                </>
            }
            meta={row ? [`namespace: ${row.namespace}`, `secrets: ${row.secrets}`] : undefined}
            groups={groups}
            testId="serviceaccount-page"
        />
    );
}
