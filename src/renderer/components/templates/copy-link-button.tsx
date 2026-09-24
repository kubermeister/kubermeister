import { useLocation } from '@tanstack/react-router';
import { LinkIcon } from 'lucide-react';
import { toast } from 'sonner';
import { formatDeepLink } from '../../../shared/deep-link';
import { Button } from '@/components/ui/button';
import { copyablePath } from '@/lib/deep-link';
import { useScope } from '@/lib/scope';

/**
 * The header's Copy link action: a `kubermeister://` link to this screen and tab under the current
 * context, which opens the same view for anybody on the same clusters. A Shell tab is copied as the
 * object's first tab, as opening one would treat it. It renders nothing until the context is known,
 * since a link without one names no cluster.
 */
export function CopyLinkButton({ tab }: { tab: string | undefined }) {
    const { context } = useScope();
    const pathname = useLocation({ select: (location) => location.pathname });
    if (!context) return null;
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(formatDeepLink(context, copyablePath(pathname, tab)));
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
