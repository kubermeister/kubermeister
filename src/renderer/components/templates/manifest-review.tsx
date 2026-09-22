import { DiffView } from '@/components/data-display/diff-view';
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

interface ManifestReviewProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The object as the editor read it, which is what the save replaces. */
    live: string;
    /** The buffer as it stands, which is what the save writes. */
    next: string;
    kind: string;
    name: string;
    /** True while the replace is in flight; the dialog then states the outcome rather than closing. */
    saving: boolean;
    onSave: () => void;
}

/**
 * What Save is about to do, before it does it. A save replaces the whole object, so the lines that
 * differ from the manifest the editor was opened with are the only account of what the write
 * actually carries — the same line diff two deployment revisions are compared with.
 */
export function ManifestReview({ open, onOpenChange, live, next, kind, name, saving, onSave }: ManifestReviewProps) {
    return (
        <AlertDialog open={open} onOpenChange={(opening) => !opening && !saving && onOpenChange(false)}>
            <AlertDialogContent className="sm:max-w-3xl" data-testid="manifest-review">
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        Save changes to {kind} “{name}”?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        The whole object is replaced with the manifest as it stands. Lines marked − go, lines marked +
                        arrive.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {/* A manifest is longer than a dialog: the diff scrolls, the buttons stay in view. */}
                <div className="max-h-[55vh] overflow-auto">
                    <DiffView
                        left={live}
                        right={next}
                        empty="No changes: this manifest is the object as it stands."
                        testId="manifest-diff"
                    />
                </div>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={saving}>Keep editing</AlertDialogCancel>
                    <AlertDialogAction
                        disabled={saving}
                        onClick={(event) => {
                            // The dialog stays open, with its buttons disabled, until the write settles.
                            event.preventDefault();
                            onSave();
                        }}
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
