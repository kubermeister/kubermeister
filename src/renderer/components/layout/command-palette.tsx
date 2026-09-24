import { KeyboardIcon, Loader2Icon, PlusIcon, RefreshCwIcon } from 'lucide-react';
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandLoading,
    CommandSeparator,
} from '@/components/ui/command';
import { ALL_DOMAINS } from '@/lib/nav';
import { useIpcQuery } from '@/lib/query';
import { useSelectNamespace, useSwitchContext } from '@/lib/scope';
import { checkForUpdates } from '@/lib/updates';
import { useNavigateTo } from './nav-link';

interface CommandPaletteProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onShowShortcuts: () => void;
}

/**
 * ⌘K / Ctrl+K quick actions: switch context or namespace, jump to any screen. The key itself is the
 * shell's shortcut dispatcher's, like every other.
 */
export function CommandPalette({ open, onOpenChange, onShowShortcuts }: CommandPaletteProps) {
    const navigateTo = useNavigateTo();
    const switchContext = useSwitchContext();
    const selectNamespace = useSelectNamespace();
    const contexts = useIpcQuery('contexts.list', {}).data ?? [];
    const namespaces = useIpcQuery('namespaces.list', {});

    const close = () => onOpenChange(false);
    const go = (path: string) => {
        close();
        navigateTo(path);
    };

    return (
        <CommandDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Quick actions"
            description="Switch cluster, namespace or resource"
            className="max-w-xl"
        >
            <CommandInput placeholder="Switch cluster, namespace or resource…" />
            <CommandList>
                <CommandEmpty>No results found.</CommandEmpty>

                <CommandGroup heading="Contexts">
                    {contexts.map((ctx) => (
                        <CommandItem
                            key={ctx.name}
                            value={`cluster ${ctx.name}`}
                            onSelect={() => {
                                close();
                                void switchContext(ctx.name);
                            }}
                        >
                            <span className="flex-1">{ctx.name}</span>
                            <span className="text-label text-text-muted">{ctx.cluster}</span>
                        </CommandItem>
                    ))}
                </CommandGroup>

                <CommandSeparator />

                <CommandGroup heading="Namespaces">
                    {namespaces.isPending && (
                        <CommandLoading label="Loading namespaces">
                            <span className="flex items-center gap-2">
                                <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
                                <span>Loading namespaces…</span>
                            </span>
                        </CommandLoading>
                    )}
                    {(namespaces.data ?? []).map((ns) => (
                        <CommandItem
                            key={ns.name}
                            value={`namespace ${ns.name}`}
                            onSelect={() => {
                                close();
                                void selectNamespace(ns.name);
                            }}
                        >
                            <span className="flex-1">{ns.name}</span>
                        </CommandItem>
                    ))}
                </CommandGroup>

                <CommandSeparator />

                <CommandGroup heading="Actions">
                    <CommandItem value="create resource" onSelect={() => go('/create')}>
                        <PlusIcon className="size-3.5 text-text-muted" />
                        <span className="flex-1">Create resource</span>
                    </CommandItem>
                    <CommandItem
                        value="check for updates"
                        onSelect={() => {
                            // The outcome shows on the Settings screen's Updates card.
                            void checkForUpdates();
                            go('/settings');
                        }}
                    >
                        <RefreshCwIcon className="size-3.5 text-text-muted" />
                        <span className="flex-1">Check for updates</span>
                    </CommandItem>
                    <CommandItem
                        value="keyboard shortcuts"
                        onSelect={() => {
                            close();
                            onShowShortcuts();
                        }}
                    >
                        <KeyboardIcon className="size-3.5 text-text-muted" />
                        <span className="flex-1">Keyboard shortcuts</span>
                    </CommandItem>
                </CommandGroup>

                <CommandSeparator />

                {ALL_DOMAINS.map((domain) => (
                    <CommandGroup key={domain.id} heading={domain.label}>
                        {domain.groups.flatMap((group) =>
                            group.items.map((item) => {
                                const Icon = item.icon;
                                return (
                                    <CommandItem
                                        key={item.path}
                                        value={`${domain.label} ${item.label}`}
                                        onSelect={() => go(item.path)}
                                    >
                                        <Icon className="size-3.5 text-text-muted" />
                                        <span>{item.label}</span>
                                    </CommandItem>
                                );
                            }),
                        )}
                    </CommandGroup>
                ))}
            </CommandList>
        </CommandDialog>
    );
}
