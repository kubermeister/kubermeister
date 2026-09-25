import { useEffect, useId, useState } from 'react';
import { DropletsIcon } from 'lucide-react';
import { DRAIN_SKIP_LABEL, type DrainSkip } from '../../../shared/k8s/drain';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useIpcQuery } from '@/lib/query';
import { useNodeDrain } from '@/lib/node-drain';
import { cn } from '@/lib/utils';

/** How many pods each reason accounts for, worded once in the shared contract. */
function skipSummary(skip: { reason: DrainSkip }[]): string {
    const counts = new Map<DrainSkip, number>();
    for (const one of skip) counts.set(one.reason, (counts.get(one.reason) ?? 0) + 1);
    return [...counts.entries()].map(([reason, count]) => `${count} ${DRAIN_SKIP_LABEL[reason]}`).join(', ');
}

/**
 * Drain a node, with the plan shown before anything happens. The plan is read for the options as
 * they stand, so toggling one re-reads it: what the dialog promises is what main will carry out.
 * While the drain runs the dialog reports each pod, and closing it stops the evictions.
 */
export function DrainDialog({ name, context }: { name: string; context: string | null }) {
    const [open, setOpen] = useState(false);
    const [force, setForce] = useState(false);
    const [deleteEmptyDirData, setDeleteEmptyDirData] = useState(false);
    const drain = useNodeDrain(context);
    const forceId = useId();
    const emptyDirId = useId();

    const plan = useIpcQuery(
        'nodes.drainPlan',
        { name, force, deleteEmptyDirData },
        { enabled: open && !drain.running && !drain.finished },
    ).data;

    // Closing the dialog ends the evictions; a drain must never outlive the screen that asked for it.
    useEffect(() => {
        if (!open) drain.stop();
    }, [open, drain]);

    const close = () => {
        if (drain.running) return;
        setOpen(false);
    };

    // An error before the first event is still something to report, so it counts as started.
    const started = drain.running || drain.finished || drain.lines.length > 0 || drain.error !== null;

    return (
        <>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                <DropletsIcon />
                Drain
            </Button>
            <AlertDialog open={open} onOpenChange={(next) => !next && close()}>
                <AlertDialogContent className="max-w-xl">
                    <AlertDialogHeader>
                        <AlertDialogTitle>Drain {name}?</AlertDialogTitle>
                        <AlertDialogDescription>
                            The node stops taking new pods, then everything a controller can put back elsewhere is
                            evicted, one pod at a time. Disruption budgets are honoured: a pod they hold back is retried
                            rather than forced.
                        </AlertDialogDescription>
                    </AlertDialogHeader>

                    {!started && (
                        <div className="flex flex-col gap-3" data-testid="drain-plan">
                            <div className="text-cell text-text-2">
                                {plan
                                    ? `${plan.evict.length} ${plan.evict.length === 1 ? 'pod' : 'pods'} to evict`
                                    : 'Reading what is on this node…'}
                                {plan && plan.skip.length > 0 && (
                                    <span className="text-text-muted">
                                        {' '}
                                        · {plan.skip.length} left alone ({skipSummary(plan.skip)})
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center justify-between gap-3">
                                <Label htmlFor={forceId} className="font-normal text-text-2">
                                    Also evict pods no controller owns
                                    <span className="block text-meta text-text-muted">
                                        Nothing will bring these back.
                                    </span>
                                </Label>
                                <Switch id={forceId} checked={force} onCheckedChange={setForce} />
                            </div>
                            <div className="flex items-center justify-between gap-3">
                                <Label htmlFor={emptyDirId} className="font-normal text-text-2">
                                    Also evict pods using emptyDir storage
                                    <span className="block text-meta text-text-muted">
                                        Their emptyDir contents are lost.
                                    </span>
                                </Label>
                                <Switch
                                    id={emptyDirId}
                                    checked={deleteEmptyDirData}
                                    onCheckedChange={setDeleteEmptyDirData}
                                />
                            </div>
                        </div>
                    )}

                    {started && (
                        <div
                            className="flex max-h-64 flex-col gap-1 overflow-y-auto"
                            role="log"
                            aria-label="Drain progress"
                            data-testid="drain-progress"
                        >
                            {drain.cordoned && <div className="text-cell text-text-muted">Node cordoned.</div>}
                            {drain.lines.map((line) => (
                                <div
                                    key={line.key}
                                    className={cn(
                                        'font-mono text-meta',
                                        line.state === 'done' && 'text-ok',
                                        line.state === 'held' && 'text-warn',
                                        line.state === 'working' && 'text-text-2',
                                    )}
                                >
                                    {line.text}
                                </div>
                            ))}
                            {drain.error && <div className="text-cell text-danger">{drain.error}</div>}
                            {drain.finished && (
                                <div className="text-cell text-text-2">
                                    Drained: {drain.evicted} evicted{drain.left ? `, ${drain.left} left` : ''}.
                                </div>
                            )}
                            {!drain.running && !drain.finished && !drain.error && (
                                <div className="text-cell text-text-muted">
                                    Stopped. The node stays cordoned until you uncordon it.
                                </div>
                            )}
                        </div>
                    )}

                    <AlertDialogFooter>
                        {drain.running ? (
                            <Button variant="outline" onClick={() => drain.stop()}>
                                Stop
                            </Button>
                        ) : (
                            <AlertDialogCancel>{started ? 'Close' : 'Cancel'}</AlertDialogCancel>
                        )}
                        {!started && (
                            <AlertDialogAction
                                variant="destructive"
                                onClick={(event) => {
                                    // The dialog stays open: its whole job now is to report the drain.
                                    event.preventDefault();
                                    drain.start({ name, force, deleteEmptyDirData });
                                }}
                            >
                                Drain
                            </AlertDialogAction>
                        )}
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
