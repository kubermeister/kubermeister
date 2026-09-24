import { createFileRoute } from '@tanstack/react-router';
import { HardDriveIcon } from 'lucide-react';
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
import { CLAIM_TONE } from '@/lib/status';

export const Route = createFileRoute('/storage/claims/$namespace/$name/{-$tab}')({ component: ClaimDetailPage });

function ClaimDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('PersistentVolumeClaim', name, namespace);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Volume', row.volume],
                          ['Capacity', row.capacity],
                          ['Access modes', row.accessModes],
                          ['Storage class', row.storageClass],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'PersistentVolumeClaim', name, namespace }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'PersistentVolumeClaim', name, namespace }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={HardDriveIcon}
            eyebrow="PersistentVolumeClaim"
            title={name}
            kind="PersistentVolumeClaim"
            namespace={namespace}
            backTo="/storage/claims"
            query={query}
            found={!!row}
            status={row ? { label: row.status, tone: CLAIM_TONE[row.status] } : undefined}
            actions={
                <>
                    <RefreshButton
                        queryKeys={[ipcQueryKey('resources.get', { kind: 'PersistentVolumeClaim', name, namespace })]}
                    />
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="PersistentVolumeClaim"
                        name={name}
                        namespace={namespace}
                        backTo="/storage/claims"
                    />
                </>
            }
            meta={row ? [`namespace: ${row.namespace}`, `capacity: ${row.capacity}`] : undefined}
            groups={groups}
            testId="claim-page"
        />
    );
}
