import type { QueryKey } from '@tanstack/react-query';
import { RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRefresh, useScreenRefresh } from '@/lib/refresh';
import { cn } from '@/lib/utils';

interface RefreshButtonProps {
    /**
     * Query-key groups to invalidate; the icon spins until the triggered refetches settle.
     * Omit to invalidate every active query (used by list pages, which mount a single list).
     */
    queryKeys?: QueryKey[];
    /** Optional text label; when omitted the button is icon-only. */
    label?: string;
}

/**
 * Header "Refresh" control: invalidates the given query keys (or all active queries when none are
 * given) and spins the icon while the click's refetches are in flight (background polling does not
 * spin it). `Mod+R` presses the newest one on screen.
 */
export function RefreshButton({ queryKeys: keys, label }: RefreshButtonProps) {
    const { refresh, refreshing } = useRefresh(keys);
    useScreenRefresh(refresh);

    return (
        <Button
            variant="ghost"
            size={label ? 'sm' : 'icon-sm'}
            aria-label={label ? undefined : 'Refresh'}
            // aria-disabled (not disabled) mid-flight so the button keeps focus while it spins.
            aria-disabled={refreshing}
            className={cn(refreshing && 'pointer-events-none opacity-50')}
            onClick={() => void refresh()}
        >
            <RefreshCwIcon className={cn(refreshing && 'animate-spin')} />
            {label}
        </Button>
    );
}
