import type { ReactElement } from 'react';
import { KbdChord } from '@/components/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** An icon-only control, named for assistive technology and with its keys in a tooltip. */
export function HeaderAction({ label, keys, children }: { label: string; keys: string[]; children: ReactElement }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild aria-label={label}>
                {children}
            </TooltipTrigger>
            <TooltipContent side="bottom" className="flex items-center gap-2">
                {label}
                <KbdChord keys={keys} tone="inverse" />
            </TooltipContent>
        </Tooltip>
    );
}
