import { useEffect, useRef, useState } from 'react';
import {
    ExternalLinkIcon,
    PackageIcon,
    DownloadIcon,
    PowerIcon,
    TriangleAlertIcon,
    type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import type { UpdateState } from '../../../shared/ipc';
import { releasePageUrl } from '../../../shared/updates';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { describeUpdate, downloadUpdate, installUpdate, pillLabel, useUpdater, type UpdateTone } from '@/lib/updates';
import { cn } from '@/lib/utils';

const ICONS: Partial<Record<UpdateState['status'], LucideIcon>> = {
    available: PackageIcon,
    downloading: DownloadIcon,
    downloaded: PowerIcon,
    error: TriangleAlertIcon,
};

const TONE_CLASS: Record<UpdateTone, string> = {
    accent: 'border-primary/40 bg-accent-bg text-primary hover:bg-accent-bg/80',
    neutral: 'border-border bg-elev-2 text-text-2 hover:bg-elev-3',
    danger: 'border-danger/40 bg-danger-bg text-danger hover:bg-danger-bg/80',
};

/**
 * Announces a version the user should know about once per version: when it is found (in the
 * notify-first mode) and when it is ready to install. Progress and errors stay in the pill.
 */
function useUpdateToasts(state: UpdateState | null): void {
    const announced = useRef<string | null>(null);
    useEffect(() => {
        if (!state || (state.status !== 'available' && state.status !== 'downloaded')) return;
        const key = `${state.status}:${state.version ?? ''}`;
        if (announced.current === key) return;
        announced.current = key;
        const { title, detail } = describeUpdate(state);
        toast(title, {
            id: 'update',
            description: detail,
            duration: 15_000,
            action:
                state.status === 'available'
                    ? { label: 'Update', onClick: () => void downloadUpdate() }
                    : { label: 'Restart', onClick: () => void installUpdate() },
        });
    }, [state]);
}

/**
 * The top bar's update indicator: hidden until a version is found, then a pill whose popover
 * carries what was found and the one action that moves it forward (download, restart, retry).
 */
export function UpdatePill() {
    const { state, check } = useUpdater();
    useUpdateToasts(state);
    const [open, setOpen] = useState(false);
    // A dismissed error stays hidden until the state moves on; the message is the identity.
    const [dismissed, setDismissed] = useState<string | null>(null);

    const pill = pillLabel(state);
    if (!state || !pill) return null;
    if (state.status === 'error' && dismissed === (state.message ?? '')) return null;

    const Icon = ICONS[state.status] ?? PackageIcon;
    const { title, detail } = describeUpdate(state);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    data-testid="update-pill"
                    data-status={state.status}
                    className={cn(
                        'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-label font-medium transition-colors',
                        TONE_CLASS[pill.tone],
                    )}
                >
                    <Icon className={cn('size-3', state.status === 'downloading' && 'animate-pulse')} />
                    {pill.label}
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-4" data-testid="update-popover">
                <div className="text-body font-semibold">{title}</div>
                {detail && (
                    <div className="mt-1.5 max-h-40 overflow-auto text-meta whitespace-pre-wrap text-text-muted">
                        {detail}
                    </div>
                )}
                {state.status === 'downloading' && (
                    <div
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={state.percent ?? 0}
                        className="mt-3 h-1.5 overflow-hidden rounded-full bg-elev-3"
                    >
                        <div
                            className="h-full bg-primary transition-[width]"
                            style={{ width: `${state.percent ?? 0}%` }}
                        />
                    </div>
                )}
                <div className="mt-3.5 flex items-center gap-2">
                    {state.status === 'available' && (
                        <Button size="sm" onClick={() => void downloadUpdate()}>
                            Update
                        </Button>
                    )}
                    {state.status === 'downloaded' && (
                        <Button size="sm" onClick={() => void installUpdate()}>
                            Restart now
                        </Button>
                    )}
                    {state.status === 'error' && (
                        <>
                            <Button size="sm" onClick={() => void check()}>
                                Try again
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                    setDismissed(state.message ?? '');
                                    setOpen(false);
                                }}
                            >
                                Dismiss
                            </Button>
                        </>
                    )}
                    {state.version && state.status !== 'error' && (
                        // A package the system owns is fetched from the release page by hand, so for
                        // that state the link is the action rather than a footnote beside one.
                        <Button size="sm" variant={state.status === 'manual' ? 'default' : 'ghost'} asChild>
                            <a href={releasePageUrl(state.version)} target="_blank" rel="noreferrer">
                                {state.status === 'manual' ? 'Get the update' : <>What&apos;s new</>}
                                <ExternalLinkIcon />
                            </a>
                        </Button>
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}
