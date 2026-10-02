import { useEffect, useEffectEvent, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useNavigateTo } from './nav-link';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { linkablePath, namespaceForLink, planDeepLink, type LinkPlan } from '@/lib/deep-link';
import { invoke, subscribe } from '@/lib/ipc';
import { useSelectNamespace, useSwitchContext } from '@/lib/scope';

type Confirm = Extract<LinkPlan, { kind: 'confirm' }>;

function failed(error: unknown): void {
    toast.error('The link could not be opened', {
        description: error instanceof Error ? error.message : String(error),
    });
}

/**
 * Opens the `kubermeister://` links the OS hands the app. It sits in the shell, behind the startup
 * gate, so a link that arrived with the launch waits in main until there is a screen to open it on.
 * A link only ever navigates: a link for a cluster the current context does not reach asks before
 * switching to one that does, and one for a cluster no context reaches says so and switches nothing.
 * A link to an object in another namespace than the one selected selects the object's.
 */
export function DeepLinkHandler() {
    const router = useRouter();
    const navigateTo = useNavigateTo();
    const switchContext = useSwitchContext();
    const selectNamespace = useSelectNamespace();
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const [choice, setChoice] = useState<string | undefined>();

    // Read once the context is settled, since a context switch can change the selection too.
    const go = async (path: string) => {
        const active = await invoke('namespace.active', {});
        const namespace = namespaceForLink(router, path, active.name);
        if (namespace !== undefined && !(await selectNamespace(namespace))) return;
        navigateTo(path);
    };

    const open = useEffectEvent(async () => {
        const { link } = await invoke('deepLink.take', {});
        if (!link) return;
        const [current, contexts] = await Promise.all([invoke('context.current', {}), invoke('contexts.list', {})]);
        const plan = planDeepLink(link, { current: current ?? undefined, contexts }, (path) =>
            linkablePath(router, path),
        );
        switch (plan.kind) {
            case 'refused':
                toast.error('That link cannot be opened', { description: plan.message });
                return;
            case 'missingCluster':
                toast.error('No context for that cluster', {
                    description: `The link opens a screen on the cluster at ${plan.server}, and no context in your kubeconfig reaches that address. Nothing was switched.`,
                });
                return;
            case 'navigate':
                setConfirm(null);
                await go(plan.path);
                return;
            case 'confirm':
                setChoice(plan.candidates[0]);
                setConfirm(plan);
        }
    });

    // The push says a link is waiting; the read on mount picks up one that came before this screen.
    useEffect(() => {
        const take = () => void open().catch(failed);
        const unsubscribe = subscribe('deep-link', take);
        take();
        return unsubscribe;
    }, []);

    const accept = async (plan: Confirm, to: string) => {
        setConfirm(null);
        try {
            if (await switchContext(to)) await go(plan.path);
        } catch (error) {
            failed(error);
        }
    };

    const several = (confirm?.candidates.length ?? 0) > 1;
    return (
        <AlertDialog open={confirm !== null} onOpenChange={(next) => !next && setConfirm(null)}>
            <AlertDialogContent data-testid="deep-link-confirm">
                <AlertDialogHeader>
                    <AlertDialogTitle>{several ? 'Switch context?' : `Switch to “${choice}”?`}</AlertDialogTitle>
                    <AlertDialogDescription>
                        The link opens a screen on the cluster at {confirm?.server}, which{' '}
                        {several ? 'these contexts reach' : `context “${choice}” reaches`}, and you are on{' '}
                        {confirm?.from ? `“${confirm.from}”` : 'no context'}. Switching ends every port forward, shell
                        and log follow open now.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {several && (
                    <Select value={choice} onValueChange={setChoice}>
                        <SelectTrigger aria-label="Context">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {confirm?.candidates.map((name) => (
                                <SelectItem key={name} value={name}>
                                    {name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
                <AlertDialogFooter>
                    <AlertDialogCancel>Stay</AlertDialogCancel>
                    <AlertDialogAction onClick={() => confirm && choice && void accept(confirm, choice)}>
                        Switch and open
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
