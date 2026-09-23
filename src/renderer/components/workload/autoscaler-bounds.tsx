import { useId, useState } from 'react';
import { SlidersHorizontalIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Popover,
    PopoverContent,
    PopoverDescription,
    PopoverHeader,
    PopoverTitle,
    PopoverTrigger,
} from '@/components/ui/popover';
import { useUpdateAutoscaler } from '@/lib/writes';

interface AutoscalerBoundsProps {
    name: string;
    namespace: string;
    min: number;
    max: number;
    /** The current CPU target, when the autoscaler watches CPU at all. */
    targetCpuPercent?: number;
}

/**
 * The three numbers an autoscaler is usually adjusted by, edited where they are read. Everything
 * else about an HPA — which metrics it watches, its scaling behaviour — stays in the manifest
 * editor, where the shape of what is changing is visible rather than implied by a field.
 */
export function AutoscalerBounds({ name, namespace, min, max, targetCpuPercent }: AutoscalerBoundsProps) {
    const [open, setOpen] = useState(false);
    const [minValue, setMinValue] = useState(String(min));
    const [maxValue, setMaxValue] = useState(String(max));
    const [target, setTarget] = useState(targetCpuPercent === undefined ? '' : String(targetCpuPercent));
    const update = useUpdateAutoscaler();
    const minId = useId();
    const maxId = useId();
    const targetId = useId();

    const minReplicas = Number(minValue);
    const maxReplicas = Number(maxValue);
    const parsedTarget = target.trim() === '' ? undefined : Number(target);
    const valid =
        Number.isInteger(minReplicas) &&
        minReplicas >= 1 &&
        Number.isInteger(maxReplicas) &&
        maxReplicas >= minReplicas &&
        (parsedTarget === undefined || (Number.isInteger(parsedTarget) && parsedTarget >= 1));

    const submit = async () => {
        if (!valid) return;
        const done = await update
            .mutateAsync({
                name,
                namespace,
                minReplicas,
                maxReplicas,
                // Only a target the reader changed is sent: sending the one it opened with would
                // rewrite the autoscaler's metrics for a save that meant to move the bounds.
                ...(parsedTarget === undefined || parsedTarget === targetCpuPercent
                    ? {}
                    : { targetCpuPercent: parsedTarget }),
            })
            .catch(() => null);
        if (!done) return;
        toast.success(`Autoscaler “${done.name}” updated`, { description: `Now ${minReplicas} to ${maxReplicas}.` });
        setOpen(false);
    };

    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                if (next) {
                    setMinValue(String(min));
                    setMaxValue(String(max));
                    setTarget(targetCpuPercent === undefined ? '' : String(targetCpuPercent));
                }
                setOpen(next);
            }}
        >
            <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                    <SlidersHorizontalIcon />
                    Edit bounds
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72">
                <PopoverHeader>
                    <PopoverTitle>Autoscaler bounds</PopoverTitle>
                    <PopoverDescription>
                        The replica range this autoscaler may choose within, and the CPU it aims for.
                    </PopoverDescription>
                </PopoverHeader>
                <div className="mt-3 flex flex-col gap-3" data-testid="autoscaler-bounds">
                    <div className="flex items-center justify-between gap-3">
                        <Label htmlFor={minId}>Minimum replicas</Label>
                        <Input
                            id={minId}
                            className="w-20"
                            value={minValue}
                            inputMode="numeric"
                            onChange={(event) => setMinValue(event.target.value)}
                        />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <Label htmlFor={maxId}>Maximum replicas</Label>
                        <Input
                            id={maxId}
                            className="w-20"
                            value={maxValue}
                            inputMode="numeric"
                            onChange={(event) => setMaxValue(event.target.value)}
                        />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <Label htmlFor={targetId}>Target CPU %</Label>
                        <Input
                            id={targetId}
                            className="w-20"
                            value={target}
                            inputMode="numeric"
                            placeholder="—"
                            onChange={(event) => setTarget(event.target.value)}
                        />
                    </div>
                    {!valid && (
                        <p className="text-meta text-danger">
                            The maximum must be at least the minimum, and both at least one.
                        </p>
                    )}
                    <Button size="sm" disabled={!valid || update.isPending} onClick={() => void submit()}>
                        {update.isPending ? 'Saving…' : 'Save'}
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
}
