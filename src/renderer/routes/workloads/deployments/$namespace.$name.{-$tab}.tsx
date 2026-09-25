import { createFileRoute } from '@tanstack/react-router';
import { ActivityIcon, BoxesIcon, HeartIcon, HistoryIcon, LayersIcon } from 'lucide-react';
import { StatusBadge } from '@/components/data-display/status-badge';
import { RefreshButton } from '@/components/refresh-button';
import { DetailCard, DetailMetrics } from '@/components/templates/detail-cards';
import { eventsTab, labelsTab, ResourceDetail, type DetailTabGroup } from '@/components/templates/resource-detail';
import { podsTab } from '@/components/templates/owned-pods';
import { workloadLogsTab } from '@/components/workload/workload-logs-tab';
import { manifestTab } from '@/components/templates/manifest-panel';
import { EditResourceButton } from '@/components/templates/edit-resource-button';
import { DeleteResourceButton } from '@/components/templates/delete-resource-button';
import { RestartButton } from '@/components/templates/restart-button';
import { ScaleButton } from '@/components/templates/scale-control';
import { PauseButton } from '@/components/deployment/pause-button';
import { RevisionCompare } from '@/components/workload/revision-compare';
import { RollbackButton } from '@/components/deployment/rollback-button';
import { RolloutStatusTab } from '@/components/deployment/rollout-status-tab';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ipcQueryKey, useIpcQuery } from '@/lib/query';
import { useResource } from '@/lib/resources';
import { useRefreshIntervalMs } from '@/lib/settings';
import { DEPLOYMENT_TONE, ROLLOUT_TONE } from '@/lib/status';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/workloads/deployments/$namespace/$name/{-$tab}')({
    component: DeploymentDetailPage,
});

function DeploymentDetailPage() {
    const { namespace, name } = Route.useParams();
    const refetchInterval = useRefreshIntervalMs();
    const query = useResource('Deployment', name, namespace);
    const deployment = query.data;
    const target = { name, namespace };
    const rollouts = useIpcQuery('deployments.rollouts', target, { refetchInterval }).data ?? [];
    const replicaSets = useIpcQuery('deployments.replicaSets', target, { refetchInterval }).data ?? [];
    const series = useIpcQuery('metrics.deploymentSeries', { namespace, name }, { refetchInterval }).data;
    const sparkCpu = series?.cpu ?? [];
    const lastCpu = sparkCpu.at(-1);

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
                                    label: 'Replicas',
                                    value: deployment ? String(deployment.replicas) : '—',
                                    sub: 'desired',
                                },
                                {
                                    label: 'Available',
                                    value: deployment ? String(deployment.available) : '—',
                                    sub: 'ready',
                                },
                                {
                                    label: 'Updated',
                                    value: deployment ? String(deployment.updated) : '—',
                                    sub: 'up-to-date',
                                },
                                {
                                    label: 'CPU',
                                    value: lastCpu != null ? `${lastCpu}m` : '—',
                                    sub: 'sum of pods',
                                    spark: sparkCpu,
                                    sparkColor: 'var(--warn)',
                                },
                            ]}
                        />
                    ),
                },
                podsTab({ kind: 'Deployment', name, namespace }),
                workloadLogsTab({ kind: 'Deployment', name, namespace }),
                eventsTab({ kind: 'Deployment', name, namespace }),
            ],
        },
        {
            label: 'ROLLOUT',
            items: [
                {
                    id: 'status',
                    label: 'Status',
                    icon: ActivityIcon,
                    content: <RolloutStatusTab name={name} namespace={namespace} />,
                },
                {
                    id: 'history',
                    label: 'History',
                    icon: HistoryIcon,
                    count: rollouts.length || undefined,
                    content: (
                        <>
                            <DetailCard
                                title="Rollout history"
                                desc={`${rollouts.length} ${rollouts.length === 1 ? 'revision' : 'revisions'}`}
                            >
                                <Table data-testid="rollout-history">
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead className="w-[60px]">Rev</TableHead>
                                            <TableHead className="w-[120px]">State</TableHead>
                                            <TableHead>Image</TableHead>
                                            <TableHead className="w-[150px]">Deployed by</TableHead>
                                            <TableHead className="w-[110px]">When</TableHead>
                                            <TableHead className="w-[90px]">Duration</TableHead>
                                            <TableHead className="w-[110px]" />
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {rollouts.map((r, i) => (
                                            <TableRow key={r.rev} data-revision={r.rev}>
                                                <TableCell className="font-mono text-primary tabular-nums">
                                                    #{r.rev}
                                                </TableCell>
                                                <TableCell>
                                                    <StatusBadge tone={ROLLOUT_TONE[r.state]}>{r.state}</StatusBadge>
                                                </TableCell>
                                                <TableCell className="font-mono text-text-2">{r.image}</TableCell>
                                                <TableCell className="font-mono text-text-muted">{r.by}</TableCell>
                                                <TableCell className="font-mono text-text-muted tabular-nums">
                                                    {r.when}
                                                </TableCell>
                                                <TableCell className="font-mono tabular-nums">{r.duration}</TableCell>
                                                <TableCell>
                                                    {i > 0 && (
                                                        <RollbackButton
                                                            name={name}
                                                            namespace={namespace}
                                                            revision={r.rev}
                                                            image={r.image}
                                                        />
                                                    )}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </DetailCard>
                            <RevisionCompare name={name} namespace={namespace} rollouts={rollouts} />
                        </>
                    ),
                },
                {
                    id: 'replicasets',
                    label: 'Replica Sets',
                    icon: LayersIcon,
                    count: replicaSets.length || undefined,
                    content: (
                        <DetailCard title="Replica Sets" desc="Generations of this deployment">
                            <Table data-testid="replica-sets">
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Name</TableHead>
                                        <TableHead className="w-[90px]">Desired</TableHead>
                                        <TableHead className="w-[90px]">Current</TableHead>
                                        <TableHead className="w-[90px]">Ready</TableHead>
                                        <TableHead className="w-[80px]">Age</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {replicaSets.map((rs) => (
                                        <TableRow key={rs.name}>
                                            <TableCell className="font-mono text-primary">{rs.name}</TableCell>
                                            <TableCell className="font-mono tabular-nums">{rs.desired}</TableCell>
                                            <TableCell className="font-mono tabular-nums">{rs.current}</TableCell>
                                            <TableCell
                                                className={cn(
                                                    'font-mono tabular-nums',
                                                    rs.ready === rs.desired && rs.desired > 0
                                                        ? 'text-ok'
                                                        : 'text-text-muted',
                                                )}
                                            >
                                                {rs.ready}
                                            </TableCell>
                                            <TableCell className="font-mono text-text-muted tabular-nums">
                                                {rs.age}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </DetailCard>
                    ),
                },
            ],
        },
        {
            label: 'INSPECT',
            items: [
                manifestTab({ kind: 'Deployment', name, namespace }),
                labelsTab(deployment ? { labels: deployment.labels, annotations: deployment.annotations } : undefined),
            ],
        },
    ];

    return (
        <ResourceDetail
            icon={BoxesIcon}
            eyebrow="Deployment"
            title={name}
            status={deployment ? { label: deployment.status, tone: DEPLOYMENT_TONE[deployment.status] } : undefined}
            meta={
                deployment
                    ? [
                          `namespace: ${deployment.namespace}`,
                          `replicas: ${deployment.ready}`,
                          `strategy: ${deployment.strategy}`,
                          deployment.image,
                      ]
                    : undefined
            }
            actions={
                <>
                    <RefreshButton
                        queryKeys={[
                            ipcQueryKey('resources.get', { kind: 'Deployment', name, namespace }),
                            ipcQueryKey('deployments.rollouts', target),
                            ipcQueryKey('deployments.replicaSets', target),
                            ipcQueryKey('metrics.deploymentSeries', target),
                            ipcQueryKey('deployments.rolloutStatus', target),
                            ipcQueryKey('resources.getYaml', { kind: 'Deployment', name, namespace }),
                        ]}
                    />
                    {deployment && (
                        <ScaleButton
                            kind="Deployment"
                            name={name}
                            namespace={namespace}
                            replicas={deployment.replicas}
                        />
                    )}
                    {deployment && <PauseButton name={name} namespace={namespace} paused={deployment.paused} />}
                    <RestartButton kind="Deployment" name={name} namespace={namespace} />
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="Deployment"
                        name={name}
                        namespace={namespace}
                        backTo="/workloads/deployments"
                    />
                </>
            }
            groups={groups}
            query={query}
            found={!!deployment}
            backTo="/workloads/deployments"
            kind="Deployment"
            namespace={namespace}
            testId="deployment-page"
        />
    );
}
