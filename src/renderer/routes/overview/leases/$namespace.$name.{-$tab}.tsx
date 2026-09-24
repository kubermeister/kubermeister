import { createFileRoute } from '@tanstack/react-router';
import { KeyRoundIcon } from 'lucide-react';
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

export const Route = createFileRoute('/overview/leases/$namespace/$name/{-$tab}')({ component: LeaseDetailPage });

function LeaseDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('Lease', name, namespace);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Holder', row.holder],
                          ['Duration', row.duration],
                          ['Renewed', row.renewed],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'Lease', name, namespace }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'Lease', name, namespace }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={KeyRoundIcon}
            eyebrow="Lease"
            title={name}
            kind="Lease"
            namespace={namespace}
            backTo="/overview/leases"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'Lease', name, namespace })]} />
                    <EditResourceButton />
                    <DeleteResourceButton kind="Lease" name={name} namespace={namespace} backTo="/overview/leases" />
                </>
            }
            meta={row ? [`holder: ${row.holder}`, `renewed: ${row.renewed}`] : undefined}
            groups={groups}
            testId="lease-page"
        />
    );
}
