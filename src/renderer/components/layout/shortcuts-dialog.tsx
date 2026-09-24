import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SHORTCUT_GROUPS, SHORTCUTS, formatChord } from '../../../shared/shortcuts';
import { shortcutPlatform } from '@/lib/platform';

interface ShortcutsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

/** A key as the cheat sheet and the sidebar hints show it. */
function Kbd({ children }: { children: string }) {
    return (
        <kbd className="rounded-sm border border-border bg-elev-2 px-1.5 py-px font-mono text-caption text-text-2">
            {children}
        </kbd>
    );
}

/**
 * The keyboard shortcuts cheat sheet, opened with `?`, from Help › Keyboard Shortcuts or from the
 * palette. Built from the shortcut table, showing the keys of the platform the app runs on; an
 * entry the platform has no key for is left out.
 */
export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg" data-testid="shortcuts-dialog">
                <DialogHeader>
                    <DialogTitle>Keyboard shortcuts</DialogTitle>
                    <DialogDescription>
                        Single keys act outside text fields; a focused shell keeps the keys it reads.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    {SHORTCUT_GROUPS.map((group) => (
                        <section key={group} aria-label={group}>
                            <h3 className="mb-1.5 text-label font-medium text-text-muted">{group}</h3>
                            <dl className="flex flex-col gap-1">
                                {SHORTCUTS.filter((s) => s.group === group && s.keys[shortcutPlatform].length > 0).map(
                                    (shortcut) => (
                                        <div key={shortcut.id} className="flex items-center gap-3 text-body">
                                            <dt className="flex-1">{shortcut.label}</dt>
                                            <dd className="flex items-center gap-1 text-text-muted">
                                                {shortcut.keys[shortcutPlatform].map((chord, index) => (
                                                    <span key={index} className="flex items-center gap-1">
                                                        {index > 0 && <span className="text-caption">or</span>}
                                                        <Kbd>{formatChord(chord, shortcutPlatform)}</Kbd>
                                                    </span>
                                                ))}
                                            </dd>
                                        </div>
                                    ),
                                )}
                            </dl>
                        </section>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    );
}
