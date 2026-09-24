import { createFileRoute } from '@tanstack/react-router';
import { ShieldIcon } from 'lucide-react';
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

export const Route = createFileRoute('/access/roles/$namespace/$name/{-$tab}')({ component: RoleDetailPage });

function RoleDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('Role', name, namespace);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Namespace', row.namespace],
                          ['Rules', String(row.rules)],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'Role', name, namespace }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'Role', name, namespace }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={ShieldIcon}
            eyebrow="Role"
            title={name}
            kind="Role"
            namespace={namespace}
            backTo="/access/roles"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'Role', name, namespace })]} />
                    <EditResourceButton />
                    <DeleteResourceButton kind="Role" name={name} namespace={namespace} backTo="/access/roles" />
                </>
            }
            meta={row ? [`namespace: ${row.namespace}`, `rules: ${row.rules}`] : undefined}
            groups={groups}
            testId="role-page"
        />
    );
}
