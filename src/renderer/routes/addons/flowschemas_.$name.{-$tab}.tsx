import { createFileRoute } from '@tanstack/react-router';
import { WavesIcon } from 'lucide-react';
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

export const Route = createFileRoute('/addons/flowschemas_/$name/{-$tab}')({ component: FlowSchemaDetailPage });

function FlowSchemaDetailPage() {
    const { name } = Route.useParams();
    const query = useResource('FlowSchema', name);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Priority level', row.priorityLevel],
                          ['Matching precedence', String(row.matchingPrecedence)],
                          ['Distinguisher', row.distinguisher],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'FlowSchema', name }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'FlowSchema', name }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={WavesIcon}
            eyebrow="FlowSchema"
            title={name}
            kind="FlowSchema"
            backTo="/addons/flowschemas"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'FlowSchema', name })]} />
                    <EditResourceButton />
                    <DeleteResourceButton kind="FlowSchema" name={name} backTo="/addons/flowschemas" />
                </>
            }
            meta={row ? [`level: ${row.priorityLevel}`, `precedence: ${row.matchingPrecedence}`] : undefined}
            groups={groups}
            testId="flowschema-page"
        />
    );
}
