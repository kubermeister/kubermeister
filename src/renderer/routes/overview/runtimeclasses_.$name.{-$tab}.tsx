import { createFileRoute } from '@tanstack/react-router';
import { CpuIcon } from 'lucide-react';
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

export const Route = createFileRoute('/overview/runtimeclasses_/$name/{-$tab}')({ component: RuntimeClassDetailPage });

function RuntimeClassDetailPage() {
    const { name } = Route.useParams();
    const query = useResource('RuntimeClass', name);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Handler', row.handler],
                          ['Node selector', row.nodeSelector],
                          ['Pod overhead', row.overhead],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'RuntimeClass', name }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'RuntimeClass', name }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={CpuIcon}
            eyebrow="RuntimeClass"
            title={name}
            kind="RuntimeClass"
            backTo="/overview/runtimeclasses"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'RuntimeClass', name })]} />
                    <EditResourceButton />
                    <DeleteResourceButton kind="RuntimeClass" name={name} backTo="/overview/runtimeclasses" />
                </>
            }
            meta={row ? [`handler: ${row.handler}`] : undefined}
            groups={groups}
            testId="runtimeclass-page"
        />
    );
}
