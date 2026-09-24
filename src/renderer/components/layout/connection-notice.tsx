import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { StatusDot } from '@/components/data-display/status-dot';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useIpcQuery } from '@/lib/query';
import { pickKubeconfig, recheckConnection, resetKubeconfig, revealSettingsFile, useSettings } from '@/lib/settings';

/**
 * The pill's words for each check that can fail; the popover carries the check's own sentence. In
 * the order they are shown when several fail: a connection that cannot work comes before a settings
 * file the app will not write, which leaves every screen working.
 */
const LABELS = {
    kubeconfig: 'Kubeconfig not loaded',
    context: 'Context unusable',
    network: 'CA bundle unreadable',
    settings: 'Settings file not saved',
} as const;

type NoticeId = keyof typeof LABELS;
const NOTICE_ORDER = Object.keys(LABELS) as NoticeId[];

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
    const failing = report.data?.checks.filter(
        (check): check is typeof check & { id: NoticeId } => check.status === 'error' && check.id in LABELS,
    );
    const problem = failing?.sort((a, b) => NOTICE_ORDER.indexOf(a.id) - NOTICE_ORDER.indexOf(b.id))[0];
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
                    {problem.id === 'settings' && (
                        <Button size="sm" variant="outline" onClick={() => void revealSettingsFile()}>
                            Show file
                        </Button>
                    )}
                    {/* A bundle that cannot be read is fixed on Settings, not by choosing another kubeconfig. */}
                    {(problem.id === 'kubeconfig' || problem.id === 'context') && (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void run(() => pickKubeconfig(client))}
                        >
                            Choose kubeconfig…
                        </Button>
                    )}
                    {(problem.id === 'kubeconfig' || problem.id === 'context') &&
                        settings.data?.connection.kubeconfigPath && (
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
