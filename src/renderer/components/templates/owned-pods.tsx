import { BoxIcon } from 'lucide-react';
import type { PodOwnerKind } from '../../../shared/k8s/owners';
import { StatusBadge } from '@/components/data-display/status-badge';
import { NavLink } from '@/components/layout/nav-link';
import { DetailCard } from '@/components/templates/detail-cards';
import { ReadFailure } from '@/components/templates/read-failure';
import type { DetailTab } from '@/components/templates/resource-detail';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useIpcQuery } from '@/lib/query';
import { useRefreshIntervalMs } from '@/lib/settings';
import { POD_TONE } from '@/lib/status';
import { cn } from '@/lib/utils';

interface OwnedPodsProps {
    kind: PodOwnerKind;
    name: string;
    namespace: string;
}

/**
 * The pods a controller actually has, resolved through owner references rather than labels, each
 * linking to its own detail. Live at the configured cadence, like every other list on a detail.
 */
export function OwnedPods({ kind, name, namespace }: OwnedPodsProps) {
    const refetchInterval = useRefreshIntervalMs();
    const query = useIpcQuery('workloads.pods', { kind, name, namespace }, { refetchInterval });
    if (!query.data) {
        return (
            <DetailCard title="Pods">
                {query.isError ? (
                    <ReadFailure
                        error={query.error}
                        subject={{ plural: 'Pods' }}
                        onRetry={() => void query.refetch()}
                    />
                ) : (
                    <p className="text-body text-text-muted">Reading the pods this {kind} owns…</p>
                )}
            </DetailCard>
        );
    }
    const pods = query.data;

    return (
        <DetailCard title="Pods" desc={`${pods.length} ${pods.length === 1 ? 'pod' : 'pods'} owned by this ${kind}`}>
            <Table data-testid="owned-pods">
                <TableHeader>
                    <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead className="w-[120px]">Status</TableHead>
                        <TableHead className="w-[80px]">Ready</TableHead>
                        <TableHead className="w-[90px]">Restarts</TableHead>
                        <TableHead className="w-[150px]">Node</TableHead>
                        <TableHead className="w-[80px]">Age</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {pods.map((pod) => (
                        <TableRow key={pod.name} data-pod={pod.name}>
                            <TableCell>
                                <NavLink
                                    to={`/workloads/pods/${pod.namespace}/${pod.name}`}
                                    className="font-mono text-primary hover:underline"
                                >
                                    {pod.name}
                                </NavLink>
                            </TableCell>
                            <TableCell>
                                <StatusBadge tone={POD_TONE[pod.status]}>{pod.status}</StatusBadge>
                            </TableCell>
                            <TableCell className="font-mono tabular-nums">{pod.ready}</TableCell>
                            <TableCell className={cn('font-mono tabular-nums', pod.restarts > 0 && 'text-warn')}>
                                {pod.restarts}
                            </TableCell>
                            <TableCell className="font-mono text-text-muted">{pod.node}</TableCell>
                            <TableCell className="font-mono text-text-muted tabular-nums">{pod.age}</TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </DetailCard>
    );
}

/** Standard "Pods" tab for a controller detail; the count rides on the tab like every other list. */
export function podsTab(target: OwnedPodsProps, count?: number): DetailTab {
    return {
        id: 'pods',
        label: 'Pods',
        icon: BoxIcon,
        count: count || undefined,
        content: <OwnedPods {...target} />,
    };
}
