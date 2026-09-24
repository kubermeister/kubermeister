import { createFileRoute } from '@tanstack/react-router';
import { CodeIcon } from 'lucide-react';
import { RefreshButton } from '@/components/refresh-button';
import { labelsTab, overviewTab, ResourceDetail, type DetailTabGroup } from '@/components/templates/resource-detail';
import { manifestTab } from '@/components/templates/manifest-panel';
import { EditResourceButton } from '@/components/templates/edit-resource-button';
import { ipcQueryKey, useIpcQuery } from '@/lib/query';
import { useRefreshIntervalMs } from '@/lib/settings';
import { NO_NAMESPACE } from './index';

export const Route = createFileRoute('/addons/instances/$crd/$namespace/$name/{-$tab}')({
    component: InstanceDetailPage,
});

function InstanceDetailPage() {
    const { crd, namespace, name } = Route.useParams();
    // A cluster-scoped instance carries a placeholder segment; it must never reach a cluster call.
    const scope = namespace === NO_NAMESPACE ? undefined : namespace;
    const input = { crd, name, namespace: scope };
    const query = useIpcQuery('customResources.get', input, { refetchInterval: useRefreshIntervalMs() });
    const row = query.data?.item ?? null;
    const columns = query.data?.columns ?? [];

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ...columns.map((column): [string, string] => [
                              column.name,
                              row.cells[column.jsonPath] ?? '—',
                          ]),
                          ['Age', row.age],
                      ]),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ crd, name, namespace: scope }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={CodeIcon}
            eyebrow={query.data?.kind ?? crd}
            title={name}
            namespace={scope}
            backTo={`/addons/instances/${encodeURIComponent(crd)}`}
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('customResources.get', input)]} />
                    <EditResourceButton />
                </>
            }
            groups={groups}
            testId="instance-page"
        />
    );
}
