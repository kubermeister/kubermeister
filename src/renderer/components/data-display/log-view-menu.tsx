import { SlidersHorizontalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { TAIL_OPTIONS } from '@/lib/log-view-options';

/** One labelled switch in the menu; they all read the same way. */
function Option({
    id,
    label,
    checked,
    onChange,
}: {
    id: string;
    label: string;
    checked: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <div className="flex items-center justify-between gap-3">
            <Label htmlFor={id} className="font-normal text-meta">
                {label}
            </Label>
            <Switch id={id} checked={checked} onCheckedChange={onChange} />
        </div>
    );
}

/**
 * Where the log console's display options live. The toolbar is one row — a second row of controls
 * was tried and taken out — and the controls that stay in reach are the ones that decide which
 * lines are shown: the container, the since window, the search and Live. What sits behind this
 * button is how those lines are read, which is asked once and then left alone.
 */
export function LogViewMenu({
    wrap,
    onWrapChange,
    timestamps,
    onTimestampsChange,
    tail,
    onTailChange,
}: {
    wrap: boolean;
    onWrapChange: (wrap: boolean) => void;
    timestamps: boolean;
    onTimestampsChange: (timestamps: boolean) => void;
    tail: number;
    onTailChange: (tail: number) => void;
}) {
    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button variant="outline" size="xs" aria-label="View options">
                    <SlidersHorizontalIcon />
                    View
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="flex w-56 flex-col gap-3 p-3">
                <Option id="log-wrap" label="Wrap long lines" checked={wrap} onChange={onWrapChange} />
                <Option
                    id="log-timestamps"
                    label="Show timestamps"
                    checked={timestamps}
                    onChange={onTimestampsChange}
                />
                <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="log-tail" className="font-normal text-meta">
                        Tail
                    </Label>
                    <Select value={String(tail)} onValueChange={(value) => onTailChange(Number(value))}>
                        <SelectTrigger id="log-tail" className="h-7 w-24 text-meta" aria-label="Tail">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {TAIL_OPTIONS.map((size) => (
                                <SelectItem key={size} value={String(size)}>
                                    {size.toLocaleString()}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </PopoverContent>
        </Popover>
    );
}
