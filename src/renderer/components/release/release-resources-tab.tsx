import { BoxesIcon } from 'lucide-react';
import { StatusBadge } from '@/components/data-display/status-badge';
import { NavLink } from '@/components/layout/nav-link';
import { DetailCard } from '@/components/templates/detail-cards';
import type { DetailTab } from '@/components/templates/resource-detail';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useIpcQuery } from '@/lib/query';
import { objectBadge, rollUp } from '@/lib/release-health';
import { useRefreshIntervalMs } from '@/lib/settings';
import { RELEASE_HEALTH_TONE } from '@/lib/status';
import type { ReleaseTarget } from '../../../shared/k8s/addons';

/**
 * The Resources tab: every object the current revision rendered, read live, under a roll-up naming
 * the object that makes the release unhealthy. The panel mounts only while the tab is open, since
 * it lists every kind the chart rendered.
 */
export function releaseResourcesTab(target: ReleaseTarget): DetailTab {
    return {
        id: 'resources',
        label: 'Resources',
        icon: BoxesIcon,
        content: <ReleaseResourcesPanel {...target} />,
    };
}

function ReleaseResourcesPanel({ name, namespace }: ReleaseTarget) {
    const refetchInterval = useRefreshIntervalMs();
    const { data, isPending, isError, error } = useIpcQuery(
        'releases.resources',
        { name, namespace },
        { refetchInterval },
    );

    if (isPending || isError) {
        return (
            <DetailCard title="Resources">
                <p className="text-body text-text-muted" data-testid="release-resources-state">
                    {isPending ? 'Reading the objects this release rendered…' : error.message}
                </p>
            </DetailCard>
        );
    }

    const rollup = rollUp(data);
    return (
        <>
            <DetailCard
                title="Health"
                desc="From the objects themselves, not from the status Helm recorded"
                action={<StatusBadge tone={RELEASE_HEALTH_TONE[rollup.health]}>{rollup.health}</StatusBadge>}
            >
                <p className="text-body text-text-2" data-testid="release-health" data-health={rollup.health}>
                    {rollup.reason}
                </p>
            </DetailCard>
            <DetailCard
                title="Objects"
                desc={`${data.length} ${data.length === 1 ? 'object' : 'objects'} the current revision rendered, read live`}
            >
                <Table data-testid="release-resources">
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-[180px]">Kind</TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead className="w-[160px]">Namespace</TableHead>
                            <TableHead className="w-[140px]">Status</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {data.map((object) => {
                            const badge = objectBadge(object);
                            return (
                                <TableRow
                                    key={`${object.apiVersion}/${object.kind}/${object.namespace ?? ''}/${object.name}`}
                                    data-object={`${object.kind}/${object.name}`}
                                    data-worst={object === rollup.worst || undefined}
                                >
                                    <TableCell className="text-text-2" title={object.apiVersion}>
                                        {object.kind}
                                    </TableCell>
                                    <TableCell className="font-mono">
                                        {object.path ? (
                                            <NavLink to={object.path} className="text-primary hover:underline">
                                                {object.name}
                                            </NavLink>
                                        ) : (
                                            <span className="text-text-2">{object.name}</span>
                                        )}
                                    </TableCell>
                                    <TableCell className="font-mono text-text-muted">
                                        {object.namespace ?? '—'}
                                    </TableCell>
                                    <TableCell title={object.note}>
                                        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </DetailCard>
        </>
    );
}
