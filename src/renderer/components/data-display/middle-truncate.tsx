import { cn } from '@/lib/utils';

/** How much of the end always stays readable; enough for a pod's generated suffix and then some. */
const KEPT_TAIL = 12;

/**
 * A name cut short in the middle rather than at its end, when it has to be cut at all. Kubernetes
 * names that share a start (one workload's pods, a release's objects) differ at the end, so an
 * ellipsis there would make two of them read the same. The end is its own element that never
 * shrinks, and the start is a plain CSS ellipsis, so the cut follows the space available rather than
 * a character count, and a name that fits is shown whole. The full name is the title.
 */
export function MiddleTruncate({ text, className }: { text: string; className?: string }) {
    if (text.length <= KEPT_TAIL * 2) {
        return (
            <span className={cn('truncate', className)} title={text}>
                {text}
            </span>
        );
    }
    return (
        <span className={cn('flex min-w-0', className)} title={text}>
            <span className="truncate">{text.slice(0, -KEPT_TAIL)}</span>
            <span className="shrink-0 whitespace-pre">{text.slice(-KEPT_TAIL)}</span>
        </span>
    );
}
