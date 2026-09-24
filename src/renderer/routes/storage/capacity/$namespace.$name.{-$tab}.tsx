import { createFileRoute } from '@tanstack/react-router';
import { GaugeIcon } from 'lucide-react';
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

export const Route = createFileRoute('/storage/capacity/$namespace/$name/{-$tab}')({
    component: StorageCapacityDetailPage,
});

function StorageCapacityDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('CSIStorageCapacity', name, namespace);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Storage class', row.storageClass],
                          ['Capacity', row.capacity],
                          ['Maximum volume size', row.maximumVolumeSize],
                          ['Topology', row.topology],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'CSIStorageCapacity', name, namespace }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'CSIStorageCapacity', name, namespace }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={GaugeIcon}
            eyebrow="CSIStorageCapacity"
            title={name}
            kind="CSIStorageCapacity"
            namespace={namespace}
            backTo="/storage/capacity"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton
                        queryKeys={[ipcQueryKey('resources.get', { kind: 'CSIStorageCapacity', name, namespace })]}
                    />
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="CSIStorageCapacity"
                        name={name}
                        namespace={namespace}
                        backTo="/storage/capacity"
                    />
                </>
            }
            meta={row ? [`class: ${row.storageClass}`, `capacity: ${row.capacity}`] : undefined}
            groups={groups}
            testId="capacity-page"
        />
    );
}
