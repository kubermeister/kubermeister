import { useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import type { PodDetail } from '../../../shared/k8s/pods';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { forwardId, startForward, stopForward, useForward, type ForwardKind } from '@/lib/port-forwards';
import { rememberForward } from '@/lib/forward-memory';
import { useQueryClient } from '@tanstack/react-query';

/** Distinct container ports a pod declares, in declaration order. */
export function declaredPorts(pod?: PodDetail | null): number[] {
    const ports = (pod?.containers ?? []).flatMap((c) => c.ports).map((p) => Number.parseInt(p, 10));
    return [...new Set(ports.filter((n) => Number.isInteger(n) && n > 0))];
}

/** A local port, or null when the text is not a valid TCP port. Empty means "same as target". */
export function parseLocalPort(text: string, fallback: number): number | null {
    const trimmed = text.trim();
    if (trimmed === '') return fallback;
    if (!/^\d+$/.test(trimmed)) return null;
    const port = Number(trimmed);
    return port >= 1 && port <= 65535 ? port : null;
}

/** Local port-forward control for the pod-detail Network tab. */
export function PortForwardControl({
    name,
    namespace,
    pod,
    kind = 'Pod',
    ports,
}: {
    name: string;
    namespace: string;
    pod?: PodDetail | null;
    /** What is being forwarded; a service resolves to whichever pod is ready. */
    kind?: ForwardKind;
    /** Ports to offer when the target is not a pod. */
    ports?: number[];
}) {
    const targetPorts = ports ?? declaredPorts(pod);
    const [targetPort, setTargetPort] = useState<number | null>(null);
    const [localPort, setLocalPort] = useState('');
    const [formError, setFormError] = useState<string | null>(null);
    const client = useQueryClient();
    const target = targetPort ?? targetPorts[0];
    const local = parseLocalPort(localPort, target ?? 0);
    // The forward this control started, looked up in the store that outlives the page.
    const forward = useForward(
        local === null || target === undefined ? null : { kind, name, namespace, localPort: local },
    );

    const start = () => {
        if (target === undefined) return;
        // Validate the local port instead of silently falling back to the target on garbage input.
        if (local === null) {
            setFormError('error: enter a valid local port (1–65535)');
            return;
        }
        setFormError(null);
        startForward({ kind, name, namespace, targetPort: target, localPort: local });
        // Remembered so it can be offered again next time this context is opened.
        void rememberForward(client, { kind, name, namespace, targetPort: target, localPort: local });
    };

    const status =
        formError ??
        (forward?.error ? `error: ${forward.error}` : null) ??
        (forward?.status ? `Listening on 127.0.0.1:${forward.status.localPort} → ${forward.status.targetPort}` : null);

    return (
        <div className="border-t border-border p-4" data-testid="port-forward">
            <div className="mb-2 text-body font-semibold">Port forward</div>
            {targetPorts.length === 0 ? (
                <div className="text-meta text-text-muted">
                    {kind === 'Pod' ? 'This pod declares no container ports.' : 'This service exposes no ports.'}
                </div>
            ) : (
                <div className="flex items-center gap-2 text-cell">
                    <span className="text-text-muted">Target</span>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="xs" disabled={!!forward} aria-label="Target port">
                                {target}
                                <ChevronDownIcon />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            {targetPorts.map((p) => (
                                <DropdownMenuItem key={p} onSelect={() => setTargetPort(p)}>
                                    {p}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <span className="ml-1 text-text-muted">Local</span>
                    <Input
                        value={localPort}
                        onChange={(e) => setLocalPort(e.target.value)}
                        placeholder={String(target ?? '')}
                        disabled={!!forward}
                        aria-label="Local port"
                        className="h-7 w-20 text-cell"
                    />
                    {forward ? (
                        <Button variant="outline" size="xs" onClick={() => stopForward(forwardId(forward))}>
                            Stop
                        </Button>
                    ) : (
                        <Button size="xs" onClick={start}>
                            Start
                        </Button>
                    )}
                </div>
            )}
            {/* The live region is always there, so a status that appears is announced rather than
                arriving together with the region that should have reported it. */}
            <div role="status">
                {status && (
                    <div
                        className="mt-2 font-mono text-label text-text-2"
                        data-testid="port-forward-status"
                        data-error={String(Boolean(formError ?? forward?.error))}
                    >
                        {status}
                    </div>
                )}
            </div>
        </div>
    );
}
