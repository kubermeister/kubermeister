import { SlidersHorizontalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import type { LogViewOptions } from '@/lib/log-view-options';

/**
 * Where the log console's display options live. The toolbar is one row — a second row of controls
 * was tried and taken out — and the controls that stay in reach are the ones that decide which
 * lines are shown: the container, the since window, the search and Live. What sits behind this
 * button is how those lines are read, which is asked once and then left alone.
 */
export function LogViewMenu({
    options,
    onChange,
}: {
    options: LogViewOptions;
    onChange: (patch: Partial<LogViewOptions>) => void;
}) {
    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button variant="outline" size="xs" aria-label="View options">
                    <SlidersHorizontalIcon />
                    View
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-3">
                <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="log-wrap" className="font-normal text-meta">
                        Wrap long lines
                    </Label>
                    <Switch id="log-wrap" checked={options.wrap} onCheckedChange={(wrap) => onChange({ wrap })} />
                </div>
            </PopoverContent>
        </Popover>
    );
}
