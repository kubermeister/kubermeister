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

export const Route = createFileRoute('/access/clusterroles_/$name/{-$tab}')({ component: ClusterRoleDetailPage });

function ClusterRoleDetailPage() {
    const { name } = Route.useParams();
    const query = useResource('ClusterRole', name);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Rules', String(row.rules)],
                          ['Aggregated', String(row.aggregated)],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'ClusterRole', name }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'ClusterRole', name }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={ShieldIcon}
            eyebrow="ClusterRole"
            title={name}
            kind="ClusterRole"
            backTo="/access/clusterroles"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'ClusterRole', name })]} />
                    <EditResourceButton />
                    <DeleteResourceButton kind="ClusterRole" name={name} backTo="/access/clusterroles" />
                </>
            }
            meta={row ? [`rules: ${row.rules}`, `aggregated: ${row.aggregated}`] : undefined}
            groups={groups}
            testId="clusterrole-page"
        />
    );
}
