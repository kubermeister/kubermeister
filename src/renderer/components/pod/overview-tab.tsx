import { RefreshCwIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { PodDetail } from '../../../shared/k8s/pods';
import { restartableOwner, type OwnerChain } from '../../../shared/k8s/owners';
import type { RestartKind } from '../../../shared/k8s/registry';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { UnavailableButton } from '@/components/unavailable-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DetailMetrics } from '@/components/templates/detail-cards';
import { ContainerRow } from '@/components/pod/container-row';
import { OwnerChainCard } from '@/components/pod/owner-chain';
import { useRestartResource } from '@/lib/writes';
import { useIpcQuery } from '@/lib/query';
import { useRefreshIntervalMs } from '@/lib/settings';
import { cn } from '@/lib/utils';

const last = (series: number[]) => series.at(-1);

/** Pod-detail Overview tab: live CPU and memory usage, conditions, and per-container detail. */
export function OverviewTab({ name, namespace, pod }: { name: string; namespace: string; pod?: PodDetail | null }) {
    const series = useIpcQuery('metrics.podSeries', { namespace, name }, { refetchInterval: useRefreshIntervalMs() });
    const chain = useIpcQuery('pods.owners', { name, namespace }).data ?? [];
    const cpu = series.data?.cpu ?? [];
    const mem = series.data?.mem ?? [];
    const conditions = pod?.conditions ?? [];
    const containers = pod?.containers ?? [];
    return (
        <>
            <DetailMetrics
                metrics={[
                    {
                        label: 'CPU',
                        value: cpu.length ? `${last(cpu)}m` : '—',
                        sub: cpu.length ? 'current usage' : 'no metrics yet',
                        spark: cpu,
                        sparkColor: 'var(--ok)',
                    },
                    {
                        label: 'Memory',
                        value: mem.length ? `${last(mem)}Mi` : '—',
                        sub: mem.length ? 'current usage' : 'no metrics yet',
                        spark: mem,
                        sparkColor: 'var(--warn)',
                    },
                ]}
            />

            <Card className="gap-0 rounded-card py-0 shadow-none" data-testid="conditions">
                <div className="border-b border-border px-4 py-3 text-body font-semibold">Conditions</div>
                <div>
                    {conditions.length === 0 && (
                        <div className="px-4 py-6 text-center text-cell text-text-muted">No conditions reported.</div>
                    )}
                    {conditions.map((c, i) => (
                        <div
                            key={c.type}
                            className={cn('flex items-center gap-2.5 px-4 py-2', i > 0 && 'border-t border-border')}
                            data-condition={c.type}
                            data-ok={String(c.ok)}
                        >
                            {c.ok ? <span className="text-ok">✓</span> : <span className="text-text-dim">—</span>}
                            <span className={cn('flex-1 text-body', c.ok ? 'text-foreground' : 'text-text-muted')}>
                                {c.type}
                            </span>
                            <span className="text-label text-text-muted">{c.time}</span>
                        </div>
                    ))}
                </div>
            </Card>

            <OwnerChainCard chain={chain} />

            <Card className="gap-0 rounded-card py-0 shadow-none" data-testid="containers">
                <div className="flex items-center border-b border-border px-4 py-3">
                    <div className="text-body font-semibold">Containers</div>
                    <Badge variant="neutral" className="ml-2 rounded-sm">
                        {containers.length}
                    </Badge>
                    <div className="flex-1" />
                    <RestartOwnerButton chain={chain} />
                </div>
                {containers.map((container, i) => (
                    <ContainerRow key={container.name} container={container} divided={i > 0} />
                ))}
            </Card>
        </>
    );
}

/**
 * Restarting a pod means restarting whatever runs it: a pod deleted on its own comes back unchanged
 * if anything brings it back at all. So this rolls the owning workload, and says plainly when the
 * pod has no owner that can be rolled.
 */
function RestartOwnerButton({ chain }: { chain: OwnerChain }) {
    const restart = useRestartResource();
    const owner = restartableOwner(chain);

    if (!owner) {
        return (
            <UnavailableButton variant="ghost" size="xs" reason="This pod has no workload to roll">
                <RefreshCwIcon />
                Restart
            </UnavailableButton>
        );
    }

    const submit = async () => {
        const done = await restart
            .mutateAsync({ kind: owner.kind as RestartKind, name: owner.name, namespace: owner.namespace })
            .catch(() => null);
        if (!done) return;
        toast.success(`${done.kind} “${done.name}” restarting`, { description: 'This pod is replaced with the rest.' });
    };

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button variant="ghost" size="xs" disabled={restart.isPending} onClick={() => void submit()}>
                    <RefreshCwIcon />
                    Restart
                </Button>
            </TooltipTrigger>
            <TooltipContent>
                Rolls {owner.kind} “{owner.name}”, replacing this pod
            </TooltipContent>
        </Tooltip>
    );
}
