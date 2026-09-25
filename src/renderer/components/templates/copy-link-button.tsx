import { useLocation } from '@tanstack/react-router';
import { LinkIcon } from 'lucide-react';
import { toast } from 'sonner';
import { formatDeepLink } from '../../../shared/deep-link';
import { Button } from '@/components/ui/button';
import { copyablePath } from '@/lib/deep-link';
import { useIpcQuery } from '@/lib/query';

/**
 * The header's Copy link action: a `kubermeister://` link to this screen and tab on the current
 * context's cluster, named by its API server, which opens the same view for anybody whose kubeconfig
 * reaches that cluster, whatever their context for it is called. It is a labelled button in the
 * header rather than an icon beside the breadcrumbs, where it was easy to miss and said nothing until
 * hovered. A Shell tab is copied as the object's first tab, as opening one would treat it. It renders
 * nothing until the context's server is known, since a link without one names no cluster.
 */
export function CopyLinkButton({ tab }: { tab: string | undefined }) {
    const server = useIpcQuery('context.current', {}).data?.server;
    const pathname = useLocation({ select: (location) => location.pathname });
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
        <Button variant="outline" size="sm" onClick={() => void copy()}>
            <LinkIcon />
            Copy link
        </Button>
    );
}
