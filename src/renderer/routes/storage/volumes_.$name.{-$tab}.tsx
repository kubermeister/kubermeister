import { createFileRoute } from '@tanstack/react-router';
import { DatabaseIcon } from 'lucide-react';
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
import { VOLUME_TONE } from '@/lib/status';

export const Route = createFileRoute('/storage/volumes_/$name/{-$tab}')({ component: VolumeDetailPage });

function VolumeDetailPage() {
    const { name } = Route.useParams();
    const query = useResource('PersistentVolume', name);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Capacity', row.capacity],
                          ['Access modes', row.accessModes],
                          ['Reclaim policy', row.reclaimPolicy],
                          ['Claim', row.claim],
                          ['Storage class', row.storageClass],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'PersistentVolume', name }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'PersistentVolume', name }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={DatabaseIcon}
            eyebrow="PersistentVolume"
            title={name}
            kind="PersistentVolume"
            backTo="/storage/volumes"
            query={query}
            found={!!row}
            status={row ? { label: row.status, tone: VOLUME_TONE[row.status] } : undefined}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'PersistentVolume', name })]} />
                    <EditResourceButton />
                    <DeleteResourceButton kind="PersistentVolume" name={name} backTo="/storage/volumes" />
                </>
            }
            meta={row ? [`capacity: ${row.capacity}`, `claim: ${row.claim}`] : undefined}
            groups={groups}
            testId="volume-page"
        />
    );
}
