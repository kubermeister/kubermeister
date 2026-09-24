import { createFileRoute } from '@tanstack/react-router';
import { PlugIcon } from 'lucide-react';
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

export const Route = createFileRoute('/storage/csidrivers_/$name/{-$tab}')({ component: CsiDriverDetailPage });

function CsiDriverDetailPage() {
    const { name } = Route.useParams();
    const query = useResource('CSIDriver', name);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Attach required', String(row.attachRequired)],
                          ['Pod info on mount', String(row.podInfoOnMount)],
                          ['Reports capacity', String(row.storageCapacity)],
                          ['fsGroup policy', row.fsGroupPolicy],
                          ['Modes', row.modes],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'CSIDriver', name }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'CSIDriver', name }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={PlugIcon}
            eyebrow="CSIDriver"
            title={name}
            kind="CSIDriver"
            backTo="/storage/csidrivers"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'CSIDriver', name })]} />
                    <EditResourceButton />
                    <DeleteResourceButton kind="CSIDriver" name={name} backTo="/storage/csidrivers" />
                </>
            }
            meta={row ? [`modes: ${row.modes}`] : undefined}
            groups={groups}
            testId="csidriver-page"
        />
    );
}
