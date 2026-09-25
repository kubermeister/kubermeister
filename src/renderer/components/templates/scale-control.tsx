import { useId, useState, type ReactNode } from 'react';
import { ChevronsUpDownIcon, MinusIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { Kind } from '../../../shared/k8s/registry';
import { Button } from '@/components/ui/button';
import { ButtonGroup, ButtonGroupText } from '@/components/ui/button-group';
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
import { useScaleResource } from '@/lib/writes';
import { cn } from '@/lib/utils';

/** Inert but focusable, so a control mid-write keeps keyboard focus instead of dropping it. */
const inertWhen = (off: boolean) => ({ 'aria-disabled': off, className: cn(off && 'pointer-events-none opacity-50') });

interface ScaleTarget {
    kind: Kind;
    name: string;
    /** Tells same-named objects apart across namespaces. */
    namespace?: string;
    /** The current desired count: what a step adjusts by one and what the popover starts from. */
    replicas: number;
}

interface ScalePopoverProps extends ScaleTarget {
    /** The control that opens the popover; rendered through `PopoverTrigger asChild`. */
    children: ReactNode;
}

/** The exact-replicas field, opened from whatever control a screen puts in front of it. */
export function ScalePopover({ kind, name, namespace, replicas, children }: ScalePopoverProps) {
    const scale = useScaleResource();
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState('');
    const inputId = useId();

    const parsed = Number(value);
    const canSubmit = value.trim() !== '' && Number.isInteger(parsed) && parsed >= 0 && parsed !== replicas;

    const submit = () => {
        if (!canSubmit || scale.isPending) return;
        scale.mutate(
            { kind, name, namespace, replicas: parsed },
            {
                onSuccess: () => {
                    toast.success(`Scaled ${kind} “${name}” to ${parsed}`);
                    setOpen(false);
                },
            },
        );
    };

    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                if (next) setValue(String(replicas));
                setOpen(next);
            }}
        >
            {children}
            <PopoverContent align="center" className="w-60">
                <PopoverHeader>
                    <PopoverTitle>Scale {kind}</PopoverTitle>
                    <PopoverDescription className="font-mono text-meta">
                        {name}
                        {namespace ? ` · ${namespace}` : ''}
                    </PopoverDescription>
                </PopoverHeader>
                <div className="mt-3 flex flex-col gap-1.5">
                    <Label htmlFor={inputId}>Replicas</Label>
                    <Input
                        id={inputId}
                        type="number"
                        min={0}
                        value={value}
                        disabled={scale.isPending}
                        onChange={(event) => setValue(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                submit();
                            }
                        }}
                        autoFocus
                    />
                    <span className="text-meta text-text-dim">current: {replicas}</span>
                </div>
                <div className="mt-4 flex justify-end gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        {...inertWhen(scale.isPending)}
                        onClick={() => {
                            if (scale.isPending) return;
                            setOpen(false);
                        }}
                    >
                        Cancel
                    </Button>
                    <Button size="sm" {...inertWhen(!canSubmit || scale.isPending)} onClick={submit}>
                        {scale.isPending ? 'Scaling…' : 'Scale'}
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
}

/** A detail header's Scale action: the same field the list opens, behind a labelled button. */
export function ScaleButton(props: ScaleTarget) {
    return (
        <ScalePopover {...props}>
            <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                    <ChevronsUpDownIcon />
                    Scale
                </Button>
            </PopoverTrigger>
        </ScalePopover>
    );
}

/**
 * Inline replica steppers for a list row. Each step writes an absolute target rather than a delta,
 * and both controls go inert while a write is in flight, so rapid clicks cannot race each other.
 * The count itself is read-only; the button beside it, shown on row hover, opens a field for an exact number.
 */
export function ScaleControl({ kind, name, namespace, replicas }: ScaleTarget) {
    const scale = useScaleResource();

    const step = (target: number) => {
        if (scale.isPending || target < 0) return;
        scale.mutate(
            { kind, name, namespace, replicas: target },
            { onSuccess: () => toast.success(`Scaled ${kind} “${name}” to ${target}`) },
        );
    };

    return (
        <div className="flex items-center gap-1">
            <ButtonGroup aria-label={`Replicas of ${kind} “${name}”`}>
                <Button
                    variant="outline"
                    size="icon-xs"
                    aria-label="Scale down"
                    {...inertWhen(scale.isPending || replicas <= 0)}
                    onClick={() => step(replicas - 1)}
                >
                    <MinusIcon />
                </Button>
                <ButtonGroupText className="min-w-8 justify-center px-1.5 font-mono text-xs font-normal tabular-nums">
                    {replicas}
                </ButtonGroupText>
                <Button
                    variant="outline"
                    size="icon-xs"
                    aria-label="Scale up"
                    {...inertWhen(scale.isPending)}
                    onClick={() => step(replicas + 1)}
                >
                    <PlusIcon />
                </Button>
            </ButtonGroup>

            {/* Revealed with the row, but only faded out rather than removed, so the keyboard still reaches it. */}
            <ScalePopover kind={kind} name={name} namespace={namespace} replicas={replicas}>
                <PopoverTrigger asChild>
                    <Button
                        variant="outline"
                        size="icon-xs"
                        className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                        aria-label={`Scale ${kind} “${name}”, currently ${replicas} replicas`}
                    >
                        <ChevronsUpDownIcon />
                    </Button>
                </PopoverTrigger>
            </ScalePopover>
        </div>
    );
}
