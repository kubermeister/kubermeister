import { useState } from 'react';
import type { Rollout } from '../../../shared/k8s/workloads';
import { DiffView } from '@/components/data-display/diff-view';
import { DetailCard } from '@/components/templates/detail-cards';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useIpcQuery } from '@/lib/query';

/**
 * Two revisions of one deployment, side by side. Both templates are canonicalised in main before
 * they get here, so what shows as a difference is what somebody changed rather than a field the
 * API server filled in differently between two generations.
 */
export function RevisionCompare({
    name,
    namespace,
    rollouts,
}: {
    name: string;
    namespace: string;
    rollouts: Rollout[];
}) {
    // Newest against the one before it: the comparison people almost always want first.
    const [to, setTo] = useState(rollouts[0]?.rev ?? '');
    const [from, setFrom] = useState(rollouts[1]?.rev ?? rollouts[0]?.rev ?? '');
    // Nothing to compare with fewer than two revisions, and nothing to ask main about either.
    const enabled = rollouts.length > 1 && !!from && !!to;
    const query = useIpcQuery('deployments.compare', { name, namespace, from, to }, { enabled });

    if (rollouts.length < 2) {
        return (
            <DetailCard title="Compare revisions">
                <p className="text-body text-text-muted" data-testid="compare-unavailable">
                    There is only one revision to look at.
                </p>
            </DetailCard>
        );
    }

    return (
        <DetailCard
            title="Compare revisions"
            desc="Older on the left, newer on the right"
            action={
                <div className="flex items-center gap-2" data-testid="compare-pickers">
                    <RevisionPicker label="From" value={from} onChange={setFrom} rollouts={rollouts} />
                    <RevisionPicker label="To" value={to} onChange={setTo} rollouts={rollouts} />
                </div>
            }
        >
            {query.isPending && enabled ? (
                <Skeleton className="h-24 w-full" />
            ) : query.data ? (
                <DiffView
                    left={query.data.from.yaml}
                    right={query.data.to.yaml}
                    empty="No differences: these revisions describe the same pod template."
                    testId="revision-diff"
                />
            ) : null}
        </DetailCard>
    );
}

function RevisionPicker({
    label,
    value,
    onChange,
    rollouts,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    rollouts: Rollout[];
}) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger className="h-8 w-28 text-body" aria-label={`${label} revision`}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {rollouts.map((rollout) => (
                    <SelectItem key={rollout.rev} value={rollout.rev}>
                        #{rollout.rev}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
