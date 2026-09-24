import { createFileRoute } from '@tanstack/react-router';
import { LayersIcon } from 'lucide-react';
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

export const Route = createFileRoute('/network/ingressclasses_/$name/{-$tab}')({ component: IngressClassDetailPage });

function IngressClassDetailPage() {
    const { name } = Route.useParams();
    const query = useResource('IngressClass', name);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Controller', row.controller],
                          ['Parameters', row.parameters],
                          ['Default class', String(row.isDefault)],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'IngressClass', name }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'IngressClass', name }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={LayersIcon}
            eyebrow="IngressClass"
            title={name}
            kind="IngressClass"
            backTo="/network/ingressclasses"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'IngressClass', name })]} />
                    <EditResourceButton />
                    <DeleteResourceButton kind="IngressClass" name={name} backTo="/network/ingressclasses" />
                </>
            }
            meta={row ? [`controller: ${row.controller}`] : undefined}
            groups={groups}
            testId="ingressclass-page"
        />
    );
}
