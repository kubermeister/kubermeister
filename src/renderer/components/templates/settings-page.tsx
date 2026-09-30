import { useLayoutEffect, type KeyboardEvent, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import { publishDetailTab } from '@/lib/detail-tab';
import { cn } from '@/lib/utils';

export interface SettingsSection {
    /** The route's last segment, so an id is part of a URL: rename one knowing old links open the first section. */
    id: string;
    label: string;
    icon: LucideIcon;
    content: ReactNode;
}

interface SettingsPageProps {
    title: string;
    desc?: string;
    sections: SettingsSection[];
}

/**
 * The settings screen: a rail of sections beside the one on show. The section is the route's
 * optional last segment, read and written here the way `ResourceDetail` handles its tabs, so a link
 * from another screen opens the section it means and a reload or Back lands where the reader was.
 */
export function SettingsPage({ title, desc, sections }: SettingsPageProps) {
    const { section: sectionParam } = useParams({ strict: false });
    // An id no section has, such as one renamed since a link was made, opens the first section.
    const active = sections.find((s) => s.id === sectionParam) ?? sections[0];
    const navigate = useNavigate();
    const pathname = useLocation({ select: (l) => l.pathname });

    // The rail replaces, so one Back leaves Settings; the first section is the bare path.
    const open = (id: string) => {
        if (id === active?.id) return;
        void navigate({
            to: '.',
            params: (prev) => ({ ...prev, section: id === sections[0]?.id ? undefined : id }),
            replace: true,
        });
    };

    const label = sectionParam ? active?.label : undefined;
    useLayoutEffect(() => publishDetailTab(pathname, label), [pathname, label]);

    const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
        const delta = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        if (delta === 0) return;
        e.preventDefault();
        const next = sections[(index + delta + sections.length) % sections.length];
        if (!next) return;
        open(next.id);
        document.getElementById(`settings-tab-${next.id}`)?.focus();
    };

    return (
        <div className="flex h-full flex-col bg-background" data-testid="settings-page">
            <div className="px-8 pt-6 pb-5">
                <h1 className="text-[18px] font-semibold tracking-tight">{title}</h1>
                {desc && <p className="mt-1 text-body text-text-muted">{desc}</p>}
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-[var(--spacing-rail)_1fr] gap-6 border-t border-border px-8">
                <div
                    role="tablist"
                    aria-label="Settings sections"
                    aria-orientation="vertical"
                    className="overflow-auto py-4 select-none"
                >
                    {sections.map((section, index) => {
                        const Icon = section.icon;
                        const selected = section.id === active?.id;
                        return (
                            <button
                                key={section.id}
                                id={`settings-tab-${section.id}`}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                aria-controls={`settings-panel-${section.id}`}
                                tabIndex={selected ? 0 : -1}
                                onClick={() => open(section.id)}
                                onKeyDown={(e) => onKeyDown(e, index)}
                                className={cn(
                                    'mb-px flex w-full items-center gap-2.5 border-l-2 py-1.5 pr-2 pl-2 text-left text-body transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                                    selected
                                        ? 'border-primary bg-elev-2 text-foreground'
                                        : 'border-transparent text-text-2 hover:bg-elev-2/60',
                                )}
                            >
                                <Icon
                                    aria-hidden
                                    className={cn('size-3.5 shrink-0', selected ? 'text-primary' : 'text-text-muted')}
                                />
                                {section.label}
                            </button>
                        );
                    })}
                </div>
                {active && (
                    <div
                        role="tabpanel"
                        id={`settings-panel-${active.id}`}
                        aria-labelledby={`settings-tab-${active.id}`}
                        className="min-h-0 overflow-auto py-4"
                        data-testid={`settings-section-${active.id}`}
                    >
                        <div className="flex max-w-[760px] flex-col gap-3.5 pb-4">
                            <h2 className="text-lead font-semibold">{active.label}</h2>
                            {active.content}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
