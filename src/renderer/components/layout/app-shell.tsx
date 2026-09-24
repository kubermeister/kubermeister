import { useState } from 'react';
import { Outlet } from '@tanstack/react-router';
import { FileUpIcon } from 'lucide-react';
import { CommandPalette } from './command-palette';
import { DeepLinkHandler } from './deep-link-handler';
import { useNavigateTo } from './nav-link';
import { ShortcutsDialog } from './shortcuts-dialog';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';
import { stageManifestImport, useManifestDrop } from '@/lib/manifest-import';
import { useShortcuts } from '@/lib/shortcuts';

export function AppShell() {
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    useShortcuts({
        paletteOpen,
        togglePalette: () => setPaletteOpen((open) => !open),
        openCheatSheet: () => setShortcutsOpen(true),
    });
    const navigateTo = useNavigateTo();
    // A manifest may be dropped while any screen is open, so the shell takes the file and the
    // Create screen is opened on what it holds.
    const { dragging } = useManifestDrop((file) => {
        stageManifestImport(file);
        navigateTo('/create');
    });
    return (
        <div className="grid h-screen grid-cols-[252px_1fr] overflow-hidden" data-testid="app-shell">
            <Sidebar onOpenPalette={() => setPaletteOpen(true)} />
            <div className="flex min-w-0 flex-col overflow-hidden">
                <TopBar />
                <main className="min-h-0 flex-1 overflow-hidden">
                    <Outlet />
                </main>
            </div>
            <CommandPalette
                open={paletteOpen}
                onOpenChange={setPaletteOpen}
                onShowShortcuts={() => setShortcutsOpen(true)}
            />
            <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
            <DeepLinkHandler />
            {dragging && (
                <div
                    className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-8"
                    data-testid="manifest-drop-target"
                >
                    <div className="flex flex-col items-center gap-2 rounded-card border-2 border-dashed border-primary px-10 py-8 text-center">
                        <FileUpIcon className="size-6 text-primary" />
                        <div className="font-medium">Drop to open the manifest</div>
                        <div className="text-cell text-text-muted">
                            It opens in Create resource; nothing is applied.
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
