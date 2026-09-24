import { createFileRoute } from '@tanstack/react-router';
import { HeartIcon, LockIcon, RouteIcon } from 'lucide-react';
import { RefreshButton } from '@/components/refresh-button';
import { DetailCard, PropertyGrid } from '@/components/templates/detail-cards';
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
import { NETWORK_TONE } from '@/lib/status';

export const Route = createFileRoute('/network/ingresses/$namespace/$name/{-$tab}')({ component: IngressDetailPage });

function IngressDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('Ingress', name, namespace);
    const ingress = query.data;
    const target = { name, namespace };
    const rules = useIpcQuery('ingresses.rules', target, { refetchInterval: useRefreshIntervalMs() }).data ?? [];
    const hostCount = new Set(rules.map((rule) => rule.host)).size;
    const tlsBlocks = ingress?.tls ?? [];

    const routingTabs: DetailTab[] = [
        {
            id: 'rules',
            label: 'Rules',
            icon: RouteIcon,
            count: rules.length || undefined,
            content: (
                <DetailCard
                    title="Rules"
                    desc={`${hostCount} ${hostCount === 1 ? 'host' : 'hosts'} · ${rules.length} ${rules.length === 1 ? 'path' : 'paths'}`}
                >
                    <Table data-testid="ingress-rules">
                        <TableHeader>
                            <TableRow>
                                <TableHead>Host</TableHead>
                                <TableHead className="w-[160px]">Path</TableHead>
                                <TableHead className="w-[180px]">Backend service</TableHead>
                                <TableHead className="w-[90px]">Port</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rules.map((rule, index) => (
                                <TableRow key={`${rule.host}${rule.path}${index}`}>
                                    <TableCell className="font-mono">{rule.host}</TableCell>
                                    <TableCell className="font-mono text-primary">{rule.path}</TableCell>
                                    <TableCell className="font-mono text-text-2">{rule.backend}</TableCell>
                                    <TableCell className="font-mono tabular-nums">{rule.port}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </DetailCard>
            ),
        },
        // Always rendered, empty state and all, so the rail does not grow after the read lands.
        {
            id: 'tls',
            label: 'TLS',
            icon: LockIcon,
            content: (
                <DetailCard title="TLS">
                    {tlsBlocks.length > 0 || ingress?.issuer ? (
                        <div className="flex flex-col gap-4" data-testid="ingress-tls">
                            {tlsBlocks.map((tls, index) => (
                                <PropertyGrid
                                    key={`${tls.secretName}-${index}`}
                                    columns={1}
                                    rows={[
                                        ['secret', tls.secretName],
                                        ['hosts', tls.hosts],
                                    ]}
                                />
                            ))}
                            {ingress?.issuer && <PropertyGrid columns={1} rows={[['issuer', ingress.issuer]]} />}
                        </div>
                    ) : (
                        <div className="text-cell text-text-muted">TLS is not configured for this ingress.</div>
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
                        <DetailCard title="Details">
                            <PropertyGrid
                                rows={[
                                    ['Class', ingress?.className ?? '—'],
                                    ['Address', ingress?.address ?? '—'],
                                    ['Hosts', String(hostCount)],
                                    ['TLS', tlsBlocks.length ? 'enabled' : 'disabled'],
                                ]}
                            />
                        </DetailCard>
                    ),
                },
                eventsTab({ kind: 'Ingress', name, namespace }),
            ],
        },
        { label: 'ROUTING', items: routingTabs },
        {
            label: 'INSPECT',
            items: [
                manifestTab({ kind: 'Ingress', name, namespace }),
                labelsTab(ingress ? { labels: ingress.labels, annotations: ingress.annotations } : undefined),
            ],
        },
    ];

    return (
        <ResourceDetail
            icon={RouteIcon}
            eyebrow="Ingress"
            title={name}
            status={ingress ? { label: ingress.status, tone: NETWORK_TONE[ingress.status] } : undefined}
            meta={
                ingress
                    ? [
                          `namespace: ${ingress.namespace}`,
                          `class: ${ingress.className}`,
                          `address: ${ingress.address}`,
                          `tls: ${tlsBlocks.length ? 'enabled' : 'disabled'}`,
                      ]
                    : undefined
            }
            actions={
                <>
                    <RefreshButton
                        queryKeys={[
                            ipcQueryKey('resources.get', { kind: 'Ingress', name, namespace }),
                            ipcQueryKey('ingresses.rules', target),
                        ]}
                    />
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="Ingress"
                        name={name}
                        namespace={namespace}
                        backTo="/network/ingresses"
                    />
                </>
            }
            groups={groups}
            query={query}
            found={!!ingress}
            backTo="/network/ingresses"
            kind="Ingress"
            namespace={namespace}
            testId="ingress-page"
        />
    );
}
