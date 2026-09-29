import { CableIcon, ExternalLinkIcon, PlayIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { RememberedForward } from '../../../shared/settings';
import { Button } from '@/components/ui/button';
import {
    Popover,
    PopoverContent,
    PopoverDescription,
    PopoverHeader,
    PopoverTitle,
    PopoverTrigger,
} from '@/components/ui/popover';
import { useIpcQuery } from '@/lib/query';
import {
    failedToBind,
    forwardId,
    forwardUrl,
    startForward,
    stopForward,
    useForwards,
    type Forward,
} from '@/lib/port-forwards';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';

/**
 * Every forward in one place, in the top bar rather than on the page that started one. A forward
 * outlives the screen it was opened from, so the only honest place to list and stop them is
 * somewhere always on screen.
 */
export function ForwardManager() {
    const forwards = useForwards();
    const context = useIpcQuery('context.current', {}).data?.name ?? null;
    const remembered = (useSettings().data?.data.forwards ?? []).filter((one) => one.context === context);
    const open = forwards.filter((forward) => forward.status);
    // Matched on the whole forward, kind and local port included: a Pod and a Service can share a
    // name, and one pod can be forwarded on several ports. One that could not bind is offered again.
    const offer = remembered.filter(
        (one) => !forwards.some((forward) => forward.id === forwardId(one) && !failedToBind(forward)),
    );

    if (forwards.length === 0 && offer.length === 0) return null;

    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button variant="ghost" size="xs" aria-label="Port forwards" data-testid="forward-manager">
                    <CableIcon />
                    <span className={cn('tabular-nums', open.length === 0 && 'text-text-muted')}>{open.length}</span>
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-96">
                <PopoverHeader>
                    <PopoverTitle>Port forwards</PopoverTitle>
                    <PopoverDescription>Open forwards stay up while you work elsewhere.</PopoverDescription>
                </PopoverHeader>
                <div className="mt-3 flex flex-col gap-2" data-testid="forward-list">
                    {forwards.map((forward) => (
                        <ForwardRow key={forward.id} forward={forward} />
                    ))}
                    {offer.map((one) => (
                        <RememberedRow key={`${one.namespace}/${one.name}/${one.localPort}`} forward={one} />
                    ))}
                </div>
            </PopoverContent>
        </Popover>
    );
}

function ForwardRow({ forward }: { forward: Forward }) {
    const url = forwardUrl(forward);
    return (
        <div className="flex items-center gap-2 text-cell" data-forward={forward.name}>
            <span
                className={cn('size-1.5 shrink-0 rounded-full', forward.error ? 'bg-danger' : 'bg-ok')}
                title={forward.error ?? 'listening'}
            />
            <div className="min-w-0 flex-1">
                <div className="truncate">
                    <span className="text-text-muted">{forward.kind}</span> {forward.name}
                </div>
                <div className="truncate font-mono text-meta text-text-muted">
                    {url} → {forward.targetPort}
                    {forward.status?.pod && forward.kind === 'Service' ? ` · ${forward.status.pod}` : ''}
                </div>
                {forward.error && <div className="text-meta text-danger">{forward.error}</div>}
            </div>
            <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Open ${url}`}
                disabled={!forward.status}
                onClick={() => window.open(url, '_blank')}
            >
                <ExternalLinkIcon />
            </Button>
            <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Stop forward ${forward.name}`}
                onClick={() => stopForward(forward.id)}
            >
                <XIcon />
            </Button>
        </div>
    );
}

/** A forward from a previous session, offered rather than started: reopening a port is a choice. */
function RememberedRow({ forward }: { forward: RememberedForward }) {
    return (
        <div className="flex items-center gap-2 text-cell text-text-muted" data-remembered={forward.name}>
            <span className="size-1.5 shrink-0 rounded-full bg-text-dim" />
            <div className="min-w-0 flex-1 truncate">
                {forward.kind} {forward.name}
                <span className="ml-1 font-mono text-meta">
                    :{forward.localPort} → {forward.targetPort}
                </span>
            </div>
            <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Restore forward ${forward.name}`}
                onClick={() => {
                    startForward(forward);
                    toast.success(`Forwarding ${forward.name} again`);
                }}
            >
                <PlayIcon />
            </Button>
        </div>
    );
}
