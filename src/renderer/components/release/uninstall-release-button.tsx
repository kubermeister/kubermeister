import { useId, useState } from 'react';
import { Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { useNavigateTo } from '@/components/layout/nav-link';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useUninstallRelease } from '@/lib/writes';

/**
 * Uninstall a release: every object its current revision rendered goes, except the ones the chart
 * annotated to be kept. The history is deleted with it unless asked otherwise, which is the one
 * choice worth offering here — everything else about an uninstall is decided by the chart.
 */
export function UninstallReleaseButton({ name, namespace }: { name: string; namespace: string }) {
    const [open, setOpen] = useState(false);
    const [keepHistory, setKeepHistory] = useState(false);
    const uninstall = useUninstallRelease();
    const navigateTo = useNavigateTo();
    const keepId = useId();

    const confirm = async () => {
        const done = await uninstall.mutateAsync({ name, namespace, keepHistory }).catch(() => null);
        setOpen(false);
        if (!done) return;
        toast.success(`Release “${done.name}” uninstalled`, {
            description: `${done.removed} object(s) removed${done.kept > 0 ? `, ${done.kept} kept by the chart` : ''}.`,
        });
        navigateTo('/helm/releases');
    };

    return (
        <>
            <Button variant="ghost" size="sm" className="text-danger" onClick={() => setOpen(true)}>
                <Trash2Icon />
                Uninstall
            </Button>
            {/* Dismissal is blocked while the write is in flight, so the dialog states the outcome. */}
            <AlertDialog open={open} onOpenChange={(next) => !next && !uninstall.isPending && setOpen(false)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Uninstall {name}?</AlertDialogTitle>
                        <AlertDialogDescription>
                            Every object this release rendered into namespace{' '}
                            <span className="font-medium text-foreground">{namespace}</span> is deleted, except any the
                            chart marked to be kept. This cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="flex items-center justify-between gap-3">
                        <Label htmlFor={keepId} className="font-normal text-text-2">
                            Keep the release history
                            <span className="block text-meta text-text-muted">
                                Its revisions stay, marked uninstalled, instead of being deleted.
                            </span>
                        </Label>
                        <Switch
                            id={keepId}
                            checked={keepHistory}
                            disabled={uninstall.isPending}
                            onCheckedChange={setKeepHistory}
                        />
                    </div>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={uninstall.isPending}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={uninstall.isPending}
                            onClick={(event) => {
                                // Keep the dialog open, with its buttons disabled, until the write settles.
                                event.preventDefault();
                                void confirm();
                            }}
                        >
                            {uninstall.isPending ? 'Uninstalling…' : 'Uninstall'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
