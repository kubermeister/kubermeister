import { createFileRoute } from '@tanstack/react-router';
import { ServerIcon } from 'lucide-react';
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

export const Route = createFileRoute('/storage/csinodes_/$name/{-$tab}')({ component: CsiNodeDetailPage });

function CsiNodeDetailPage() {
    const { name } = Route.useParams();
    const query = useResource('CSINode', name);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Drivers', String(row.drivers)],
                          ['Registered', row.driverNames],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'CSINode', name }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'CSINode', name }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={ServerIcon}
            eyebrow="CSINode"
            title={name}
            kind="CSINode"
            backTo="/storage/csinodes"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'CSINode', name })]} />
                    <EditResourceButton />
                    <DeleteResourceButton kind="CSINode" name={name} backTo="/storage/csinodes" />
                </>
            }
            meta={row ? [`drivers: ${row.drivers}`] : undefined}
            groups={groups}
            testId="csinode-page"
        />
    );
}
