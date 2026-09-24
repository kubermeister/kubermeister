import { createFileRoute } from '@tanstack/react-router';
import { CopyIcon } from 'lucide-react';
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
import { SNAPSHOT_TONE } from '@/lib/status';

export const Route = createFileRoute('/storage/snapshots/$namespace/$name/{-$tab}')({ component: SnapshotDetailPage });

function SnapshotDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('VolumeSnapshot', name, namespace);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Source PVC', row.sourcePvc],
                          ['Restore size', row.restoreSize],
                          ['Ready', row.ready],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'VolumeSnapshot', name, namespace }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'VolumeSnapshot', name, namespace }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={CopyIcon}
            eyebrow="VolumeSnapshot"
            title={name}
            kind="VolumeSnapshot"
            namespace={namespace}
            backTo="/storage/snapshots"
            query={query}
            found={!!row}
            status={row ? { label: row.ready, tone: SNAPSHOT_TONE[row.ready] } : undefined}
            actions={
                <>
                    <RefreshButton
                        queryKeys={[ipcQueryKey('resources.get', { kind: 'VolumeSnapshot', name, namespace })]}
                    />
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="VolumeSnapshot"
                        name={name}
                        namespace={namespace}
                        backTo="/storage/snapshots"
                    />
                </>
            }
            meta={row ? [`namespace: ${row.namespace}`, `source: ${row.sourcePvc}`] : undefined}
            groups={groups}
            testId="snapshot-page"
        />
    );
}
