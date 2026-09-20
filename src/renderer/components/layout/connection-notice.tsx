import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { StatusDot } from '@/components/data-display/status-dot';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useIpcQuery } from '@/lib/query';
import { pickKubeconfig, recheckConnection, resetKubeconfig, useSettings } from '@/lib/settings';

/** The pill's words for each check that can fail; the popover carries the check's own sentence. */
const LABELS = { kubeconfig: 'Kubeconfig not loaded', context: 'Context unusable' } as const;

/**
 * A kubeconfig that would not load, or a current context whose cluster or user the file does not
 * define, named once in the top bar with its fixes, instead of a screen that keeps the shell from
 * opening. Every cluster read fails the same way until it is fixed, so the notice reads the startup
 * report the gate already fetched and the fixes refetch that report: the notice goes away the moment
 * a kubeconfig loads and its current context resolves, from here, from Settings or from a context
 * switch. "Use default" is offered only while a path override is set, since with none set there is
 * nothing to clear.
 */
export function ConnectionNotice() {
    const client = useQueryClient();
    const report = useIpcQuery('startupChecks', {}, { staleTime: Infinity, gcTime: Infinity });
    const settings = useSettings();
    const [busy, setBusy] = useState(false);
    const problem = report.data?.checks.find(
        (check): check is typeof check & { id: keyof typeof LABELS } => check.status === 'error' && check.id in LABELS,
    );
    if (!problem) return null;

    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        try {
            await action();
        } finally {
            setBusy(false);
        }
    };

    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 border-danger/40 px-2.5 text-danger"
                    data-testid="connection-notice"
                >
                    <StatusDot tone="danger" />
                    <span className="font-medium">{LABELS[problem.id]}</span>
                </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-96 space-y-3 text-body">
                <div className="space-y-1">
                    <p className="font-medium">{problem.label}</p>
                    {problem.detail && <p className="text-text-muted">{problem.detail}</p>}
                    {problem.hint && <p className="text-text-muted italic">{problem.hint}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy} onClick={() => void run(() => recheckConnection(client))}>
                        {busy ? 'Checking…' : 'Try again'}
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void run(() => pickKubeconfig(client))}
                    >
                        Choose kubeconfig…
                    </Button>
                    {settings.data?.connection.kubeconfigPath && (
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void run(() => resetKubeconfig(client))}
                        >
                            Use default kubeconfig
                        </Button>
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}
