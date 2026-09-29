import { StatusBadge } from '@/components/data-display/status-badge';
import { Meter } from '@/components/data-display/meter';
import { DetailCard, PropertyGrid } from '@/components/templates/detail-cards';
import { ReadFailure } from '@/components/templates/read-failure';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useIpcQuery } from '@/lib/query';
import { useRefreshIntervalMs } from '@/lib/settings';
import type { StatusTone } from '@/lib/status';

/** A condition reads by its status, not its name: True is good for the ones a Deployment reports. */
const CONDITION_TONE: Record<string, StatusTone> = { True: 'ok', False: 'danger', Unknown: 'warn' };

/**
 * Live progress of a rolling update: how far the new generation has come, what the controller says
 * about it, and how many pods each generation still holds. Polled at the configured cadence, like
 * every other live read.
 */
export function RolloutStatusTab({ name, namespace }: { name: string; namespace: string }) {
    const refetchInterval = useRefreshIntervalMs();
    const query = useIpcQuery('deployments.rolloutStatus', { name, namespace }, { refetchInterval });
    const status = query.data;
    if (!status) {
        return (
            <DetailCard title="Rollout">
                {query.isError ? (
                    <ReadFailure
                        error={query.error}
                        subject={{ one: 'Deployment' }}
                        onRetry={() => void query.refetch()}
                    />
                ) : (
                    <p className="text-body text-text-muted" data-testid="rollout-pending">
                        Reading the rollout…
                    </p>
                )}
            </DetailCard>
        );
    }

    const progress = status.desired === 0 ? 100 : Math.round((status.updated / status.desired) * 100);
    const tone: StatusTone = status.paused ? 'neutral' : status.settled ? 'ok' : 'warn';
    const state = status.paused ? 'Paused' : status.settled ? 'Settled' : 'Rolling out';

    return (
        <>
            <DetailCard title="Rollout" desc={`${progress}% of replicas updated`}>
                <div className="flex flex-col gap-3" data-testid="rollout-progress">
                    <div className="flex items-center gap-2">
                        <StatusBadge tone={tone}>{state}</StatusBadge>
                        {status.paused && (
                            <span className="text-meta text-text-muted">
                                No further change is applied until the rollout is resumed.
                            </span>
                        )}
                    </div>
                    <Meter value={progress} tone={tone === 'neutral' ? 'accent' : tone} label="Updated replicas" />
                    <PropertyGrid
                        rows={[
                            ['Desired', String(status.desired)],
                            ['Updated', String(status.updated)],
                            ['Ready', String(status.ready)],
                            ['Available', String(status.available)],
                            ['Unavailable', String(status.unavailable)],
                        ]}
                        columns={3}
                    />
                </div>
            </DetailCard>

            <DetailCard title="Conditions" desc="What the controller reports">
                <Table data-testid="rollout-conditions">
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-[130px]">Type</TableHead>
                            <TableHead className="w-[90px]">Status</TableHead>
                            <TableHead className="w-[190px]">Reason</TableHead>
                            <TableHead>Message</TableHead>
                            <TableHead className="w-[110px]">When</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {status.conditions.map((condition) => (
                            <TableRow key={condition.type} data-condition={condition.type}>
                                <TableCell className="font-mono text-text-2">{condition.type}</TableCell>
                                <TableCell>
                                    <StatusBadge tone={CONDITION_TONE[condition.status] ?? 'neutral'}>
                                        {condition.status}
                                    </StatusBadge>
                                </TableCell>
                                <TableCell className="font-mono text-text-muted">{condition.reason}</TableCell>
                                <TableCell className="text-text-muted">{condition.message}</TableCell>
                                <TableCell className="font-mono text-text-muted tabular-nums">
                                    {condition.when}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </DetailCard>

            <DetailCard title="Generations" desc="Pods held by each revision">
                <Table data-testid="rollout-generations">
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-[60px]">Rev</TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead className="w-[90px]">Role</TableHead>
                            <TableHead className="w-[90px]">Desired</TableHead>
                            <TableHead className="w-[90px]">Current</TableHead>
                            <TableHead className="w-[90px]">Ready</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {status.sets.map((set) => (
                            <TableRow key={set.name} data-generation={set.rev}>
                                <TableCell className="font-mono text-primary tabular-nums">#{set.rev}</TableCell>
                                <TableCell className="font-mono text-text-2">{set.name}</TableCell>
                                <TableCell>
                                    <StatusBadge tone={set.role === 'new' ? 'accent' : 'neutral'}>
                                        {set.role === 'new' ? 'New' : 'Old'}
                                    </StatusBadge>
                                </TableCell>
                                <TableCell className="font-mono tabular-nums">{set.desired}</TableCell>
                                <TableCell className="font-mono tabular-nums">{set.current}</TableCell>
                                <TableCell className="font-mono tabular-nums">{set.ready}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </DetailCard>
        </>
    );
}
