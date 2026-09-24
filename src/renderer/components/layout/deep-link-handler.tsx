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
import { linkablePath, planDeepLink, type LinkPlan } from '@/lib/deep-link';
import { invoke, subscribe } from '@/lib/ipc';
import { useSwitchContext } from '@/lib/scope';

type Confirm = Extract<LinkPlan, { kind: 'confirm' }>;

function failed(error: unknown): void {
    toast.error('The link could not be opened', {
        description: error instanceof Error ? error.message : String(error),
    });
}

/**
 * Opens the `kubermeister://` links the OS hands the app. It sits in the shell, behind the startup
 * gate, so a link that arrived with the launch waits in main until there is a screen to open it on.
 * A link only ever navigates: a link for another context asks before switching, and one for a
 * context the kubeconfig lacks says so and switches nothing.
 */
export function DeepLinkHandler() {
    const router = useRouter();
    const navigateTo = useNavigateTo();
    const switchContext = useSwitchContext();
    const [confirm, setConfirm] = useState<Confirm | null>(null);

    const open = useEffectEvent(async () => {
        const { link } = await invoke('deepLink.take', {});
        if (!link) return;
        const [current, contexts] = await Promise.all([invoke('context.current', {}), invoke('contexts.list', {})]);
        const plan = planDeepLink(
            link,
            { current: current?.name, contexts: contexts.map((context) => context.name) },
            (path) => linkablePath(router, path),
        );
        switch (plan.kind) {
            case 'refused':
                toast.error('That link cannot be opened', { description: plan.message });
                return;
            case 'missingContext':
                toast.error('Context not in your kubeconfig', {
                    description: `The link opens a screen in “${plan.context}”, which your kubeconfig does not have. Nothing was switched.`,
                });
                return;
            case 'navigate':
                setConfirm(null);
                navigateTo(plan.path);
                return;
            case 'confirm':
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

    const accept = async (plan: Confirm) => {
        setConfirm(null);
        try {
            await switchContext(plan.to);
            navigateTo(plan.path);
        } catch (error) {
            failed(error);
        }
    };

    return (
        <AlertDialog open={confirm !== null} onOpenChange={(next) => !next && setConfirm(null)}>
            <AlertDialogContent data-testid="deep-link-confirm">
                <AlertDialogHeader>
                    <AlertDialogTitle>Switch to “{confirm?.to}”?</AlertDialogTitle>
                    <AlertDialogDescription>
                        The link opens a screen in context “{confirm?.to}”, and you are on{' '}
                        {confirm?.from ? `“${confirm.from}”` : 'no context'}. Switching ends every port forward, shell
                        and log follow open now. The namespace selection stays as it is.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Stay</AlertDialogCancel>
                    <AlertDialogAction onClick={() => confirm && void accept(confirm)}>
                        Switch and open
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
