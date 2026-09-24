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
import { API_SERVICE_TONE } from '@/lib/status';

export const Route = createFileRoute('/addons/apiservices_/$name/{-$tab}')({ component: ApiServiceDetailPage });

function ApiServiceDetailPage() {
    const { name } = Route.useParams();
    const query = useResource('APIService', name);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Group', row.group],
                          ['Version', row.version],
                          ['Backing service', row.service],
                          ['Reason', row.reason],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'APIService', name }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'APIService', name }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={PlugIcon}
            eyebrow="APIService"
            title={name}
            kind="APIService"
            backTo="/addons/apiservices"
            query={query}
            found={!!row}
            status={row ? { label: row.status, tone: API_SERVICE_TONE[row.status] } : undefined}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'APIService', name })]} />
                    <EditResourceButton />
                    <DeleteResourceButton kind="APIService" name={name} backTo="/addons/apiservices" />
                </>
            }
            meta={row ? [`service: ${row.service}`, `version: ${row.version}`] : undefined}
            groups={groups}
            testId="apiservice-page"
        />
    );
}
