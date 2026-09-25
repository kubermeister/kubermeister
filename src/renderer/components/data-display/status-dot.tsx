import { cn } from '@/lib/utils';
import type { StatusTone } from '@/lib/status';

// Colored tones carry a soft halo (a 2px ring in the tone's translucent bg token); the neutral/dim
// tone stays flat. One consistent rule for every status dot in the app.
const DOT_TONE: Record<StatusTone, string> = {
    ok: 'bg-ok shadow-[0_0_0_2px_var(--ok-bg)]',
    warn: 'bg-warn shadow-[0_0_0_2px_var(--warn-bg)]',
    danger: 'bg-danger shadow-[0_0_0_2px_var(--danger-bg)]',
    accent: 'bg-primary shadow-[0_0_0_2px_var(--accent-bg)]',
    neutral: 'bg-text-dim',
};

/**
 * The small round status indicator used in badges and the top-bar cluster-health dot. A colour says
 * nothing to a screen reader, so a dot with a `title` is an image named by it, and one without is
 * decoration beside a word that already says the same thing and is hidden from assistive tech.
 */
export function StatusDot({ tone, title, className }: { tone: StatusTone; title?: string; className?: string }) {
    const semantics = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true };
    return <span title={title} {...semantics} className={cn('size-1.5 rounded-full', DOT_TONE[tone], className)} />;
}
