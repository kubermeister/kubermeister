import { createFileRoute } from '@tanstack/react-router';
import { GlobeIcon, HeartIcon, PlugIcon, TagIcon, WaypointsIcon } from 'lucide-react';
import { StatusBadge } from '@/components/data-display/status-badge';
import { RefreshButton } from '@/components/refresh-button';
import { DetailCard, DetailMetrics, PropertyGrid } from '@/components/templates/detail-cards';
import { PortForwardControl } from '@/components/pod/port-forward-control';
import {
    eventsTab,
    labelsTab,
    ResourceDetail,
    type DetailTab,
    type DetailTabGroup,
} from '@/components/templates/resource-detail';
import { manifestTab } from '@/components/templates/manifest-panel';
import { EditResourceButton } from '@/components/templates/edit-resource-button';
import { DeleteResourceButton } from '@/components/templates/delete-resource-button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ipcQueryKey, useIpcQuery } from '@/lib/query';
import { useResource } from '@/lib/resources';
import { useRefreshIntervalMs } from '@/lib/settings';
import { ENDPOINT_TONE, NETWORK_TONE } from '@/lib/status';

export const Route = createFileRoute('/network/services/$namespace/$name/{-$tab}')({ component: ServiceDetailPage });

function ServiceDetailPage() {
    const { namespace, name } = Route.useParams();
    const refetchInterval = useRefreshIntervalMs();
    const query = useResource('Service', name, namespace);
    const service = query.data;
    const target = { name, namespace };
    const ports = useIpcQuery('services.ports', target, { refetchInterval }).data ?? [];
    const endpoints = useIpcQuery('services.endpoints', target, { refetchInterval }).data ?? [];
    const readyCount = endpoints.filter((endpoint) => endpoint.ready === 'Ready').length;
    const selector = service?.selector ?? [];

    const networkTabs: DetailTab[] = [
        {
            id: 'ports',
            label: 'Ports',
            icon: PlugIcon,
            count: ports.length || undefined,
            content: (
                <DetailCard title="Ports">
                    <Table data-testid="service-ports">
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-[120px]">Name</TableHead>
                                <TableHead className="w-[90px]">Port</TableHead>
                                <TableHead className="w-[110px]">Protocol</TableHead>
                                <TableHead className="w-[120px]">Target</TableHead>
                                <TableHead>App protocol</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {ports.map((port) => (
                                <TableRow key={port.name}>
                                    <TableCell className="font-mono">{port.name}</TableCell>
                                    <TableCell className="font-mono tabular-nums">{port.port}</TableCell>
                                    <TableCell className="font-mono">{port.protocol}</TableCell>
                                    <TableCell className="font-mono tabular-nums">{port.target}</TableCell>
                                    <TableCell className="font-mono text-text-muted">{port.appProtocol}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                    {/* A service forward re-resolves to a ready pod per connection, so it survives
                        the rollout that would end a forward aimed at one pod. */}
                    <PortForwardControl
                        kind="Service"
                        name={name}
                        namespace={namespace}
                        ports={ports
                            .map((port) => Number.parseInt(port.port, 10))
                            .filter((port) => Number.isInteger(port) && port > 0)}
                    />
                </DetailCard>
            ),
        },
        {
            id: 'endpoints',
            label: 'Endpoints',
            icon: WaypointsIcon,
            count: endpoints.length || undefined,
            content: (
                <DetailCard title="Endpoints" desc="Backing pods">
                    <Table data-testid="service-endpoints">
                        <TableHeader>
                            <TableRow>
                                <TableHead>Pod</TableHead>
                                <TableHead className="w-[150px]">Node</TableHead>
                                <TableHead className="w-[150px]">Address</TableHead>
                                <TableHead className="w-[110px]">Ready</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {endpoints.map((endpoint) => (
                                <TableRow key={`${endpoint.pod}-${endpoint.address}`}>
                                    <TableCell className="font-mono text-primary">{endpoint.pod}</TableCell>
                                    <TableCell className="font-mono text-text-muted">{endpoint.node}</TableCell>
                                    <TableCell className="font-mono tabular-nums">{endpoint.address}</TableCell>
                                    <TableCell>
                                        <StatusBadge tone={ENDPOINT_TONE[endpoint.ready]}>{endpoint.ready}</StatusBadge>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </DetailCard>
            ),
        },
        // Always rendered, empty state and all, so the rail does not grow after the read lands.
        {
            id: 'selector',
            label: 'Selector',
            icon: TagIcon,
            count: selector.length || undefined,
            content: (
                <DetailCard title="Selector">
                    {selector.length > 0 ? (
                        <PropertyGrid columns={3} rows={selector} />
                    ) : (
                        <div className="text-cell text-text-muted">This service has no selector.</div>
                    )}
                </DetailCard>
            ),
        },
    ];

    const groups: DetailTabGroup[] = [
        {
            label: 'OBSERVE',
            items: [
                {
                    id: 'overview',
                    label: 'Overview',
                    icon: HeartIcon,
                    content: (
                        <DetailMetrics
                            metrics={[
                                {
                                    label: 'Endpoints',
                                    value: String(endpoints.length),
                                    sub: `${readyCount} ready · ${endpoints.length - readyCount} not ready`,
                                },
                                { label: 'Ports', value: String(ports.length), sub: service?.ports ?? '—' },
                            ]}
                        />
                    ),
                },
                eventsTab({ kind: 'Service', name, namespace }),
            ],
        },
        { label: 'NETWORK', items: networkTabs },
        {
            label: 'INSPECT',
            items: [
                manifestTab({ kind: 'Service', name, namespace }),
                labelsTab(service ? { labels: service.labels, annotations: service.annotations } : undefined),
            ],
        },
    ];

    return (
        <ResourceDetail
            icon={GlobeIcon}
            eyebrow="Service"
            title={name}
            status={service ? { label: service.status, tone: NETWORK_TONE[service.status] } : undefined}
            meta={
                service
                    ? [
                          `namespace: ${service.namespace}`,
                          `type: ${service.type}`,
                          `clusterIP: ${service.clusterIp}`,
                          `age: ${service.age}`,
                      ]
                    : undefined
            }
            actions={
                <>
                    <RefreshButton
                        queryKeys={[
                            ipcQueryKey('resources.get', { kind: 'Service', name, namespace }),
                            ipcQueryKey('services.ports', target),
                            ipcQueryKey('services.endpoints', target),
                        ]}
                    />
                    <EditResourceButton />
                    <DeleteResourceButton kind="Service" name={name} namespace={namespace} backTo="/network/services" />
                </>
            }
            groups={groups}
            query={query}
            found={!!service}
            backTo="/network/services"
            kind="Service"
            namespace={namespace}
            testId="service-page"
        />
    );
}
