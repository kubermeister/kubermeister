import { createFileRoute } from '@tanstack/react-router';
import { BoxIcon, HeartIcon, ScrollIcon, TerminalIcon, WaypointsIcon } from 'lucide-react';
import { RefreshButton } from '@/components/refresh-button';
import { eventsTab, labelsTab, ResourceDetail, type DetailTabGroup } from '@/components/templates/resource-detail';
import { manifestTab } from '@/components/templates/manifest-panel';
import { relatedTab } from '@/components/templates/related-tab';
import { describeTab } from '@/components/templates/describe-panel';
import { EditResourceButton } from '@/components/templates/edit-resource-button';
import { DeleteResourceButton } from '@/components/templates/delete-resource-button';
import { EvictButton } from '@/components/pod/evict-button';
import { LogsTab } from '@/components/pod/logs-tab';
import { NetworkTab } from '@/components/pod/network-tab';
import { OverviewTab } from '@/components/pod/overview-tab';
import { ShellTab } from '@/components/pod/shell-tab';
import { ipcQueryKey } from '@/lib/query';
import { useResource } from '@/lib/resources';
import { POD_TONE } from '@/lib/status';

export const Route = createFileRoute('/workloads/pods/$namespace/$name/{-$tab}')({ component: PodDetailPage });

function PodDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('Pod', name, namespace);
    const pod = query.data;
    const portCount = pod?.containers.reduce((sum, c) => sum + c.ports.length, 0);

    const groups: DetailTabGroup[] = [
        {
            label: 'OBSERVE',
            items: [
                {
                    id: 'overview',
                    label: 'Overview',
                    icon: HeartIcon,
                    content: <OverviewTab name={name} namespace={namespace} pod={pod} />,
                },
                {
                    id: 'logs',
                    label: 'Logs',
                    icon: ScrollIcon,
                    fill: true,
                    keepMounted: true,
                    content: <LogsTab name={name} namespace={namespace} pod={pod} />,
                },
                relatedTab({ kind: 'Pod', name, namespace }),
                eventsTab({ kind: 'Pod', name, namespace }),
            ],
        },
        {
            label: 'INSPECT',
            items: [
                manifestTab({ kind: 'Pod', name, namespace }),
                describeTab({ kind: 'Pod', name, namespace }),
                labelsTab(pod ? { labels: pod.labels, annotations: pod.annotations } : undefined),
                {
                    id: 'network',
                    label: 'Network',
                    icon: WaypointsIcon,
                    count: portCount || undefined,
                    keepMounted: true,
                    content: <NetworkTab name={name} namespace={namespace} pod={pod} />,
                },
            ],
        },
        {
            label: 'CONNECT',
            items: [
                {
                    id: 'shell',
                    label: 'Shell',
                    icon: TerminalIcon,
                    fill: true,
                    content: <ShellTab name={name} namespace={namespace} pod={pod} />,
                },
            ],
        },
    ];

    return (
        <ResourceDetail
            icon={BoxIcon}
            eyebrow="Pod"
            title={name}
            status={pod ? { label: pod.status, tone: POD_TONE[pod.status] } : undefined}
            meta={[
                `namespace: ${pod?.namespace ?? namespace}`,
                `age: ${pod?.age ?? '—'}`,
                `restarts: ${pod?.restarts ?? 0}`,
            ]}
            actions={
                <>
                    <RefreshButton
                        queryKeys={[
                            ipcQueryKey('resources.get', { kind: 'Pod', name, namespace }),
                            ['pods.logSnapshot'],
                            ['events.forObject'],
                        ]}
                    />
                    <EditResourceButton />
                    <EvictButton name={name} namespace={namespace} />
                    <DeleteResourceButton kind="Pod" name={name} namespace={namespace} backTo="/workloads/pods" />
                </>
            }
            groups={groups}
            query={query}
            found={!!pod}
            backTo="/workloads/pods"
            kind="Pod"
            namespace={namespace}
            testId="pod-page"
        />
    );
}
