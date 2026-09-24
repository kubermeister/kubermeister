import { useRouterState } from '@tanstack/react-router';
import { LinkIcon } from 'lucide-react';
import { toast } from 'sonner';
import { formatDeepLink } from '../../../shared/deep-link';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { copyablePath } from '@/lib/deep-link';
import { useIpcQuery } from '@/lib/query';

/**
 * Copy link, beside the breadcrumbs: a `kubermeister://` link to this screen and tab on the current
 * context's cluster, named by its API server, which opens the same view for anybody whose kubeconfig
 * reaches that cluster, whatever their context for it is called. It sits with the
 * breadcrumb rather than among the header's actions because it says where you are and does nothing
 * to the object. A Shell tab is copied as the object's first tab, as opening one would treat it. It
 * renders nothing until the context's server is known, since a link without one names no cluster.
 */
export function CopyLinkButton() {
    const server = useIpcQuery('context.current', {}).data?.server;
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    // The top bar sits outside the route, so the tab is read from the deepest match's params.
    const tab = useRouterState({
        select: (state) => (state.matches.at(-1)?.params as { tab?: string } | undefined)?.tab,
    });
    if (!server) return null;
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(formatDeepLink(server, copyablePath(pathname, tab)));
            toast.success('Link copied');
        } catch {
            toast.error('The link could not be copied');
        }
    };
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="Copy link" onClick={() => void copy()}>
                    <LinkIcon />
                </Button>
            </TooltipTrigger>
            <TooltipContent>Copy link</TooltipContent>
        </Tooltip>
    );
}
