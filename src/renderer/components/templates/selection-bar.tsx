import { useState } from 'react';
import type { Table } from '@tanstack/react-table';
import { DownloadIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { DANGEROUS_KINDS, type ManifestKind } from '../../../shared/k8s/manifest';
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
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { bulkDeleteSummary, failedSelection, type SelectionTarget } from '@/lib/selection';
import { useIpcMutation } from '@/lib/query';
import { useBulkDeleteResources } from '@/lib/writes';

/** How many names the confirmation lists before summarizing the rest. */
const SHOWN_NAMES = 8;

interface SelectionBarProps<T> {
    table: Table<T>;
    kind: ManifestKind;
    /** The plural the page title uses, for the count copy. */
    noun: string;
}

/**
 * The selection bar above a list: invisible until rows are checked, then it says how many and acts
 * on exactly those — saving their manifests to a file, or deleting them unless the kind is one of
 * `DANGEROUS_KINDS`. Targets come from the table's own selection, so a search that hides rows also
 * excludes them.
 *
 * Objects are deleted one by one, the outcome is a single summary, and whatever failed stays
 * selected so a retry starts from there.
 */
export function SelectionBar<T>({ table, kind, noun }: SelectionBarProps<T>) {
    const [open, setOpen] = useState(false);
    const bulk = useBulkDeleteResources();
    // Not a cluster write, but the same hook: the file is named in a native dialog, and a failed
    // read or save reports itself through the shared mutation-error toast like every other action.
    const exportYaml = useIpcMutation('resources.exportYaml');

    const targets: SelectionTarget[] = table.getSelectedRowModel().rows.map((row) => {
        const original = row.original as { name: string; namespace?: string };
        return { name: original.name, namespace: original.namespace };
    });
    if (targets.length === 0) return null;

    const spansNamespaces = new Set(targets.map((target) => target.namespace ?? '')).size > 1;
    const nameOf = (target: SelectionTarget) =>
        spansNamespaces && target.namespace ? `${target.namespace}/${target.name}` : target.name;
    const shown = targets.slice(0, SHOWN_NAMES);
    const hidden = targets.length - shown.length;
    const countOf = (many: number) => `${many} ${many === 1 ? kind : noun}`;

    const confirm = async () => {
        const result = await bulk.mutateAsync({ kind, targets }).catch(() => null);
        setOpen(false);
        if (!result) return;
        table.setRowSelection(failedSelection(result.failed));
        const summary = bulkDeleteSummary(result, kind, noun);
        if (summary.ok) toast.success(summary.message);
        else toast.error(summary.message, { description: summary.detail });
    };

    /** A dismissed save dialog is an answer, not a failure, so it passes without a word. */
    const save = async (clean: boolean) => {
        const result = await exportYaml.mutateAsync({ kind, clean, targets }).catch(() => null);
        if (!result?.path) return;
        const missing = targets.length - result.count;
        toast.success(`${countOf(result.count)} saved`, {
            description: missing ? `${result.path} — ${missing} could not be read and were left out.` : result.path,
        });
    };

    return (
        <div className="flex items-center gap-1.5" data-testid="selection-bar">
            <span className="text-cell text-text-muted">
                <span className="font-mono text-foreground tabular-nums">{targets.length}</span> selected
            </span>
            <Button variant="ghost" size="sm" onClick={() => table.resetRowSelection()}>
                Clear
            </Button>
            {/* The clean-up is the choice itself, so it is made here rather than in a dialog after it. */}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" disabled={exportYaml.isPending}>
                        <DownloadIcon />
                        {exportYaml.isPending ? 'Saving…' : `Export ${targets.length}`}
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuLabel>Save {countOf(targets.length)} as YAML</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={() => void save(false)}>As the cluster holds them</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void save(true)}>Cleaned for another cluster</DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            {/* A kind whose single delete asks for its name to be typed gets no bulk delete at all:
                a checkbox column and a delete that reaches beyond the object do not go together,
                and a batch cannot ask for one name per object. Export still works. */}
            {!DANGEROUS_KINDS.has(kind) && (
                <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
                    <Trash2Icon />
                    Delete {targets.length}
                </Button>
            )}
            {/* Dismissal is blocked while the batch is in flight, so the dialog states the outcome. */}
            <AlertDialog open={open} onOpenChange={(next) => !next && !bulk.isPending && setOpen(false)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete {countOf(targets.length)}?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This permanently deletes{' '}
                            <span className="font-medium text-foreground">
                                {shown.map(nameOf).join(', ')}
                                {hidden > 0 ? ` and ${hidden} more` : ''}
                            </span>
                            . This cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={bulk.isPending}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={bulk.isPending}
                            onClick={(event) => {
                                // Keep the dialog open, with its buttons disabled, until the batch settles.
                                event.preventDefault();
                                void confirm();
                            }}
                        >
                            {bulk.isPending ? 'Deleting…' : `Delete ${targets.length}`}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
