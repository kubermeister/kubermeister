import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * A Button for an action that cannot apply to the object on screen. Rendered `aria-disabled` rather
 * than natively disabled so it stays keyboard-focusable and its reason is announced on focus;
 * activation is suppressed and the tooltip surfaces the reason on hover and focus.
 */
export function UnavailableButton({ reason, className, ...props }: ComponentProps<typeof Button> & { reason: string }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    type="button"
                    {...props}
                    aria-disabled
                    onClick={(event) => event.preventDefault()}
                    className={cn('opacity-50', className)}
                />
            </TooltipTrigger>
            <TooltipContent>{reason}</TooltipContent>
        </Tooltip>
    );
}
