import { createFileRoute } from '@tanstack/react-router';
import { ArrowUpNarrowWideIcon } from 'lucide-react';
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

export const Route = createFileRoute('/overview/priorityclasses_/$name/{-$tab}')({
    component: PriorityClassDetailPage,
});

function PriorityClassDetailPage() {
    const { name } = Route.useParams();
    const query = useResource('PriorityClass', name);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Value', String(row.value)],
                          ['Preemption', row.preemption],
                          ['Global default', String(row.globalDefault)],
                          ['Description', row.description],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'PriorityClass', name }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'PriorityClass', name }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={ArrowUpNarrowWideIcon}
            eyebrow="PriorityClass"
            title={name}
            kind="PriorityClass"
            backTo="/overview/priorityclasses"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'PriorityClass', name })]} />
                    <EditResourceButton />
                    <DeleteResourceButton kind="PriorityClass" name={name} backTo="/overview/priorityclasses" />
                </>
            }
            meta={row ? [`value: ${row.value}`, `preemption: ${row.preemption}`] : undefined}
            groups={groups}
            testId="priorityclass-page"
        />
    );
}
