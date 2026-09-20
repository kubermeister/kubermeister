import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { StartupCheck } from '../../shared/ipc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const ICON = {
    ok: <CheckCircle2 className="size-4 text-emerald-500" aria-hidden />,
    warning: <AlertTriangle className="size-4 text-amber-500" aria-hidden />,
    error: <XCircle className="size-4 text-red-500" aria-hidden />,
};

/**
 * The screen for a bridge that cannot answer the startup checks at all. A kubeconfig problem is not
 * shown here any more: the shell opens and the top bar's connection notice carries it.
 */
export function StartupError({
    checks,
    retrying,
    onRetry,
}: {
    checks: StartupCheck[];
    retrying: boolean;
    onRetry: () => void;
}) {
    return (
        <div className="flex h-screen items-center justify-center p-6">
            <Card className="w-full max-w-lg" data-testid="startup-error">
                <CardHeader>
                    <CardTitle>Kubermeister cannot start yet</CardTitle>
                    <CardDescription>Fix the failing check below, then try again.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <ul className="space-y-3">
                        {checks.map((check) => (
                            <li key={check.id} className="flex gap-3" data-check={check.id} data-status={check.status}>
                                <span className="mt-0.5">{ICON[check.status]}</span>
                                <div className="space-y-0.5 text-sm">
                                    <p className="font-medium">{check.label}</p>
                                    {check.detail && <p className="text-muted-foreground">{check.detail}</p>}
                                    {check.hint && <p className="text-muted-foreground italic">{check.hint}</p>}
                                </div>
                            </li>
                        ))}
                    </ul>
                    <div className="flex flex-wrap gap-2">
                        <Button onClick={onRetry} disabled={retrying}>
                            {retrying ? 'Checking…' : 'Try again'}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
