import { cn } from '@/lib/utils';

/** `inverse` sits on a tooltip, whose colours are the page's turned around. */
type KbdTone = 'default' | 'inverse';

/** A key outlined like a keycap rather than set as plain text. */
export function Kbd({ children, tone = 'default' }: { children: string; tone?: KbdTone }) {
    return (
        <kbd
            className={cn(
                'inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-[4px] border px-1 font-mono text-caption leading-none',
                tone === 'inverse'
                    ? 'border-background/25 bg-background/10 text-background/80'
                    : 'border-border border-b-border-hi bg-elev-2 text-text-2 shadow-[0_1px_0_var(--border-hi)]',
            )}
        >
            {children}
        </kbd>
    );
}

/** A chord as one keycap per key. */
export function KbdChord({ keys, tone }: { keys: string[]; tone?: KbdTone }) {
    return (
        <span className="flex items-center gap-0.5">
            {keys.map((key, index) => (
                <Kbd key={index} tone={tone}>
                    {key}
                </Kbd>
            ))}
        </span>
    );
}
