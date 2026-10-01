import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { MiddleTruncate } from '@/components/data-display/middle-truncate';
import { StatusBadge } from '@/components/data-display/status-badge';
import type { StatusTone } from '@/lib/status';
import { spaceKind } from '@/lib/utils';

export interface DetailHeaderProps {
    icon?: LucideIcon;
    eyebrow?: string;
    title: string;
    status?: { label: string; tone: StatusTone };
    meta?: string[];
    actions?: ReactNode;
}

/**
 * Shared detail-screen header: icon chip + eyebrow + title + status badge + a row of mono meta
 * strings, with optional right-aligned actions. Every detail screen renders this one header.
 *
 * The title block keeps a width of its own, so when the actions do not fit beside it they move to a
 * row under it rather than squeezing it to nothing, which on a narrow window hid the object's name
 * and stood its meta one word to a line.
 */
export function DetailHeader({ icon: Icon, eyebrow, title, status, meta, actions }: DetailHeaderProps) {
    return (
        <div className="px-4.5 py-3.5">
            <div className="flex flex-wrap items-start gap-x-3.5 gap-y-3">
                <div className="flex min-w-72 flex-1 items-start gap-3.5">
                    {Icon && (
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-bg text-primary">
                            <Icon className="size-4.5" />
                        </div>
                    )}
                    <div className="min-w-0 flex-1">
                        {eyebrow && (
                            <div className="text-label font-medium tracking-wider text-text-muted uppercase">
                                {spaceKind(eyebrow)}
                            </div>
                        )}
                        <div className="flex items-center gap-2.5 text-base font-semibold tracking-tight">
                            {/* Cut in the middle, if at all: one workload's pods differ at the end. */}
                            <MiddleTruncate text={title} />
                            {status && (
                                <StatusBadge tone={status.tone} className="shrink-0">
                                    {status.label}
                                </StatusBadge>
                            )}
                        </div>
                        {meta && meta.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-x-3.5 gap-y-0.5 font-mono text-meta text-text-muted wrap-anywhere">
                                {meta.map((m, i) => (
                                    <span key={i}>{m}</span>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
                {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
            </div>
        </div>
    );
}
