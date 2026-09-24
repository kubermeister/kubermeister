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

export const Route = createFileRoute('/access/clusterrolebindings_/$name/{-$tab}')({
    component: ClusterRoleBindingDetailPage,
});

function ClusterRoleBindingDetailPage() {
    const { name } = Route.useParams();
    const query = useResource('ClusterRoleBinding', name);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Role', row.role],
                          ['Subjects', String(row.subjects)],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'ClusterRoleBinding', name }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'ClusterRoleBinding', name }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={ShieldCheckIcon}
            eyebrow="ClusterRoleBinding"
            title={name}
            kind="ClusterRoleBinding"
            backTo="/access/clusterrolebindings"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'ClusterRoleBinding', name })]} />
                    <EditResourceButton />
                    <DeleteResourceButton kind="ClusterRoleBinding" name={name} backTo="/access/clusterrolebindings" />
                </>
            }
            meta={row ? [`role: ${row.role}`, `subjects: ${row.subjects}`] : undefined}
            groups={groups}
            testId="clusterrolebinding-page"
        />
    );
}
