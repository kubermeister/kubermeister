import { createFileRoute } from '@tanstack/react-router';
import { FileTextIcon, HeartIcon } from 'lucide-react';
import { RefreshButton } from '@/components/refresh-button';
import { DetailCard, PropertyGrid } from '@/components/templates/detail-cards';
import { eventsTab, labelsTab, ResourceDetail, type DetailTabGroup } from '@/components/templates/resource-detail';
import { manifestTab } from '@/components/templates/manifest-panel';
import { EditResourceButton } from '@/components/templates/edit-resource-button';
import { DeleteResourceButton } from '@/components/templates/delete-resource-button';
import { ipcQueryKey, useIpcQuery } from '@/lib/query';
import { useResource } from '@/lib/resources';
import { useRefreshIntervalMs } from '@/lib/settings';

export const Route = createFileRoute('/workloads/configmaps/$namespace/$name/{-$tab}')({
    component: ConfigMapDetailPage,
});

function ConfigMapDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('ConfigMap', name, namespace);
    const configMap = query.data;
    const entries =
        useIpcQuery('configMaps.entries', { name, namespace }, { refetchInterval: useRefreshIntervalMs() }).data ?? [];

    const groups: DetailTabGroup[] = [
        {
            label: 'OBSERVE',
            items: [
                {
                    id: 'overview',
                    label: 'Overview',
                    icon: HeartIcon,
                    content: (
                        <DetailCard title="Details">
                            <PropertyGrid
                                rows={[
                                    ['Namespace', configMap?.namespace ?? namespace],
                                    ['Keys', String(configMap?.keys ?? entries.length)],
                                    ['Size', configMap?.size ?? '—'],
                                    ['Age', configMap?.age ?? '—'],
                                ]}
                            />
                        </DetailCard>
                    ),
                },
                eventsTab({ kind: 'ConfigMap', name, namespace }),
            ],
        },
        {
            label: 'DATA',
            items: [
                {
                    id: 'data',
                    label: 'Entries',
                    icon: FileTextIcon,
                    count: entries.length || undefined,
                    content: (
                        <div className="flex flex-col gap-3" data-testid="configmap-entries">
                            {entries.map((entry) => (
                                <DetailCard
                                    key={entry.key}
                                    title={entry.key}
                                    desc={`${entry.contentType} · ${entry.size}`}
                                >
                                    <pre className="overflow-auto rounded-md bg-code-bg p-4 font-mono text-meta leading-[1.65] text-text-2">
                                        {entry.value}
                                    </pre>
                                </DetailCard>
                            ))}
                        </div>
                    ),
                },
            ],
        },
        {
            label: 'INSPECT',
            items: [
                manifestTab({ kind: 'ConfigMap', name, namespace }),
                labelsTab(configMap ? { labels: configMap.labels, annotations: configMap.annotations } : undefined),
            ],
        },
    ];

    return (
        <ResourceDetail
            icon={FileTextIcon}
            eyebrow="ConfigMap"
            title={name}
            kind="ConfigMap"
            namespace={namespace}
            backTo="/workloads/configmaps"
            query={query}
            found={!!configMap}
            actions={
                <>
                    <RefreshButton
                        queryKeys={[
                            ipcQueryKey('resources.get', { kind: 'ConfigMap', name, namespace }),
                            ipcQueryKey('configMaps.entries', { name, namespace }),
                        ]}
                    />
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="ConfigMap"
                        name={name}
                        namespace={namespace}
                        backTo="/workloads/configmaps"
                    />
                </>
            }
            meta={[
                `namespace: ${configMap?.namespace ?? namespace}`,
                `keys: ${configMap?.keys ?? entries.length}`,
                `size: ${configMap?.size ?? '—'}`,
            ]}
            groups={groups}
            testId="configmap-page"
        />
    );
}
