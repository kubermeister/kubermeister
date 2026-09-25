import { useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { ChevronDownIcon, SearchIcon } from 'lucide-react';
import { KMLogo } from '@/components/km-logo';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { NavLink } from './nav-link';
import { DOMAINS, SETTINGS_NAV, activeSectionId, isActivePath, type Domain, type NavItem } from '@/lib/nav';
import { shortcutPlatform } from '@/lib/platform';
import { formatChord, shortcutById, type ShortcutId } from '../../../shared/shortcuts';
import { cn } from '@/lib/utils';

const hintFor = (id: ShortcutId) => formatChord(shortcutById(id).keys[shortcutPlatform][0]!, shortcutPlatform);

export function Sidebar({ onOpenPalette }: { onOpenPalette: () => void }) {
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const currentId = activeSectionId(pathname);
    // Every domain starts open and a manual toggle sticks, except that navigating into a collapsed
    // domain reopens it so the current item is never hidden. The reset happens during render, keyed
    // on the current domain, because effects may not call setState.
    const [state, setState] = useState<{ currentId: string | undefined; open: Record<string, boolean> }>({
        currentId,
        open: {},
    });
    if (state.currentId !== currentId) {
        setState({ currentId, open: currentId ? { ...state.open, [currentId]: true } : state.open });
    }
    const isOpen = (id: string) => state.open[id] ?? true;
    const setOpen = (id: string, open: boolean) =>
        setState((prev) => ({ ...prev, open: { ...prev.open, [id]: open } }));

    return (
        <aside
            className="flex w-[252px] flex-col overflow-hidden border-r border-border bg-background select-none"
            data-testid="sidebar"
        >
            <div className="flex items-center border-b border-border px-3.5 pt-3.5 pb-3">
                <KMLogo size={20} />
            </div>
            <ScrollArea className="min-h-0 flex-1">
                <nav className="px-1.5 py-2" aria-label="Main">
                    {DOMAINS.map((section) => (
                        <SidebarSection
                            key={section.id}
                            section={section}
                            current={section.id === currentId}
                            open={isOpen(section.id)}
                            onOpenChange={(open) => setOpen(section.id, open)}
                            pathname={pathname}
                        />
                    ))}
                </nav>
            </ScrollArea>
            <div className="border-t border-border">
                <button
                    type="button"
                    onClick={onOpenPalette}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-body text-text-2 transition-colors -outline-offset-2 hover:bg-elev-2/60"
                    data-testid="quick-actions"
                >
                    <SearchIcon className="size-3.25 text-text-muted" />
                    <span className="flex-1 text-left">Quick actions</span>
                    <span className="font-mono text-caption text-text-dim">{hintFor('palette')}</span>
                </button>
                <div className="h-px bg-border" />
                <SidebarItem
                    item={SETTINGS_NAV}
                    flat
                    active={isActivePath(pathname, SETTINGS_NAV.path)}
                    hint={hintFor('settings')}
                />
            </div>
        </aside>
    );
}

function SidebarSection({
    section,
    current,
    open,
    onOpenChange,
    pathname,
}: {
    section: Domain;
    current: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    pathname: string;
}) {
    const SectionIcon = section.icon;
    return (
        <Collapsible open={open} onOpenChange={onOpenChange} className="mb-0.5">
            <CollapsibleTrigger
                className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-body transition-colors',
                    current ? 'font-semibold text-foreground' : 'font-medium text-text-2 hover:bg-elev-2/60',
                )}
            >
                <SectionIcon className={cn('size-3.5', current ? 'text-primary' : 'text-text-muted')} />
                <span className="flex-1 text-left">{section.label}</span>
                <ChevronDownIcon className={cn('size-3 text-text-dim transition-transform', !open && '-rotate-90')} />
            </CollapsibleTrigger>
            <CollapsibleContent className="pb-1">
                {section.groups.map((group, i) => (
                    <div key={group.label ?? i}>
                        {group.label && (
                            <div className="pt-2 pr-2.5 pb-0.5 pl-[34px] text-eyebrow font-semibold tracking-[0.1em] text-text-dim">
                                {group.label}
                            </div>
                        )}
                        {group.items.map((item) => (
                            <SidebarItem key={item.id} item={item} active={isActivePath(pathname, item.path)} />
                        ))}
                    </div>
                ))}
            </CollapsibleContent>
        </Collapsible>
    );
}

function SidebarItem({
    item,
    active,
    flat = false,
    hint,
}: {
    item: NavItem;
    active: boolean;
    /** A footer entry outside any section: full width, no indent. */
    flat?: boolean;
    hint?: string;
}) {
    const Icon = item.icon;
    return (
        <NavLink
            to={item.path}
            aria-current={active ? 'page' : undefined}
            className={cn(
                'relative mb-px flex items-center gap-2.5 rounded py-1 pr-2.5 text-body transition-colors',
                // A footer entry spans the aside, whose overflow would clip an outline drawn outside.
                flat ? 'mb-0 rounded-none px-4 py-2.5 -outline-offset-2' : 'pl-[34px]',
                active ? 'bg-elev-2 text-foreground' : 'text-text-2 hover:bg-elev-2/60',
            )}
        >
            {active && (
                <span
                    className={cn(
                        'absolute top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary',
                        flat ? 'left-0.5' : 'left-6',
                    )}
                />
            )}
            <Icon className={cn('size-3.25', active ? 'text-primary' : 'text-text-muted')} />
            <span className="flex-1 truncate">{item.label}</span>
            {hint && <span className="font-mono text-caption text-text-dim">{hint}</span>}
        </NavLink>
    );
}
