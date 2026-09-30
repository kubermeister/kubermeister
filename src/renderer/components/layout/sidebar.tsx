import { useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { ChevronDownIcon, ZapIcon } from 'lucide-react';
import { chordKeys, shortcutById, type ShortcutId } from '../../../shared/shortcuts';
import { HeaderAction } from './header-action';
import { KMLogo } from '@/components/km-logo';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { NavLink } from './nav-link';
import { DOMAINS, activeSectionId, isActivePath, type Domain, type NavItem } from '@/lib/nav';
import { shortcutPlatform } from '@/lib/platform';
import { cn } from '@/lib/utils';

const keysFor = (id: ShortcutId) => chordKeys(shortcutById(id).keys[shortcutPlatform][0]!, shortcutPlatform);

const HEADER_ICON =
    'flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors outline-none hover:bg-elev-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring';
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
            <div className="flex items-center gap-1 border-b border-border pt-2.5 pr-2 pb-2 pl-3.5">
                <KMLogo size={20} className="mr-auto" />
                <HeaderAction label="Quick actions" keys={keysFor('palette')}>
                    <button type="button" onClick={onOpenPalette} className={HEADER_ICON} data-testid="quick-actions">
                        <ZapIcon className="size-3.75" aria-hidden />
                    </button>
                </HeaderAction>
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

function SidebarItem({ item, active }: { item: NavItem; active: boolean }) {
    const Icon = item.icon;
    return (
        <NavLink
            to={item.path}
            aria-current={active ? 'page' : undefined}
            className={cn(
                'relative mb-px flex items-center gap-2.5 rounded py-1 pr-2.5 pl-[34px] text-body transition-colors',
                active ? 'bg-elev-2 text-foreground' : 'text-text-2 hover:bg-elev-2/60',
            )}
        >
            {active && <span className="absolute top-1.5 bottom-1.5 left-6 w-0.5 rounded-full bg-primary" />}
            <Icon className={cn('size-3.25', active ? 'text-primary' : 'text-text-muted')} />
            <span className="flex-1 truncate">{item.label}</span>
        </NavLink>
    );
}
