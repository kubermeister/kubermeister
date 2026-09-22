import { useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { CheckIcon, CodeIcon, DiffIcon, DownloadIcon, EyeIcon, PencilIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { ManifestKind } from '../../../shared/k8s/manifest';
import { YamlEditor } from '@/components/data-display/yaml-editor';
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
import { Skeleton } from '@/components/ui/skeleton';
import { downloadTextFile } from '@/lib/download';
import { describeError } from '@/lib/k8s-error';
import { useIpcQuery } from '@/lib/query';
import { useReplaceResource } from '@/lib/writes';
import { cn } from '@/lib/utils';
import { useRegisterManifestEdit } from './manifest-edit';
import { ManifestReview } from './manifest-review';
import type { DetailTab } from './resource-detail';

interface ManifestPanelProps {
    /** A registered kind; omitted for an instance of a definition the app has no entry for. */
    kind?: ManifestKind;
    /** The definition's own name, for an instance read through `customResources.getYaml`. */
    crd?: string;
    name: string;
    /** Tells same-named objects apart across namespaces; omitted for cluster-scoped kinds. */
    namespace?: string;
}

/**
 * The object's YAML, read through whichever channel knows the kind. A custom resource cannot go
 * through `resources.getYaml`, whose input is the registry's own kinds, so it is read through its
 * definition instead; both answer the same manifest shape, and only one of the two ever runs.
 */
function useManifestQuery({ kind, crd, name, namespace }: ManifestPanelProps) {
    const custom = useIpcQuery('customResources.getYaml', { crd: crd ?? '', name, namespace }, { enabled: !!crd });
    const standard = useIpcQuery(
        'resources.getYaml',
        // The placeholder kind is never sent: the query stays disabled whenever a definition is named.
        { kind: kind ?? 'Pod', name, namespace },
        { enabled: !crd },
    );
    return crd ? custom : standard;
}

/**
 * The shared Manifest tab: the object's live YAML, read-only until the page asks for edit mode.
 * Saving is a full replace carrying the resource version the object was read with, so a change made
 * elsewhere in the meantime is reported rather than overwritten. It fills the body and stays
 * mounted, because the editor owns its scrolling and an edit must survive a tab switch.
 */
export function manifestTab(props: ManifestPanelProps): DetailTab {
    return {
        id: 'manifest',
        label: 'Manifest',
        icon: CodeIcon,
        hint: 'YAML',
        fill: true,
        keepMounted: true,
        content: <ManifestPanel {...props} />,
    };
}

const FRAME = 'flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-border';

// The single resourceVersion line. Buffer and fresh read come from the same serializer, so a
// targeted replace keeps the user's own formatting where a parse and re-dump would not.
const RESOURCE_VERSION_RE = /^(\s*)resourceVersion:.*$/m;

/**
 * Re-stamp the buffer with the resource version of a fresh read, so a save that lost a race can be
 * retried without discarding the edits. Null when either side has no such line.
 */
export function spliceResourceVersion(buffer: string, freshYaml: string): string | null {
    const fresh = RESOURCE_VERSION_RE.exec(freshYaml);
    if (!fresh || !RESOURCE_VERSION_RE.test(buffer)) return null;
    return buffer.replace(RESOURCE_VERSION_RE, fresh[0]);
}

/** Inert but focusable, so a control mid-write keeps keyboard focus instead of dropping it to the body. */
const inertWhen = (off: boolean) => ({ 'aria-disabled': off, className: cn(off && 'pointer-events-none opacity-50') });

export function ManifestPanel({ kind, crd, name, namespace }: ManifestPanelProps) {
    const query = useManifestQuery({ kind, crd, name, namespace });
    const replace = useReplaceResource();
    const [editing, setEditing] = useState(false);
    // The user's buffer; null means untouched, so the live read shows as it is.
    const [edits, setEdits] = useState<string | null>(null);
    const [confirmCancel, setConfirmCancel] = useState(false);
    // Open from Review changes until the write settles: Save writes what the buffer says straight
    // away, and this is the other way in, for an edit whose diff is worth reading first.
    const [reviewing, setReviewing] = useState(false);
    // Armed when a save was rejected as a conflict: retrying the same stale version would only
    // repeat it, so the banner offers a reload that keeps the edits.
    const [conflict, setConflict] = useState(false);

    const liveKind = query.data?.kind ?? kind ?? crd;
    const text = edits ?? query.data?.yaml ?? '';
    const dirty = editing && edits !== null && edits !== query.data?.yaml;
    const empty = text.trim().length === 0;

    const exitEdit = () => {
        setEditing(false);
        setEdits(null);
        setConflict(false);
        setReviewing(false);
    };

    const enterEdit = async () => {
        // Re-read first, so the buffer carries a current resource version to write back with.
        await query.refetch();
        setEdits(null);
        setEditing(true);
    };

    useRegisterManifestEdit(() => void enterEdit());

    const blocker = useBlocker({
        shouldBlockFn: () => dirty,
        enableBeforeUnload: false,
        withResolver: true,
    });

    // The object this panel was opened on. Main refuses a manifest that names any other object, so
    // an edited name or a removed namespace line cannot turn a save into a write elsewhere. A
    // custom resource pins the kind the read came back with, since only its definition knows it.
    const expect = { kind: kind ?? query.data?.kind ?? '', name, namespace };

    const handleSave = async () => {
        // The global mutation toast already reports the failure; a conflict additionally arms the banner.
        const updated = await replace.mutateAsync({ manifest: text, expect }).catch((error: unknown) => {
            if (describeError(error).kind === 'conflict') setConflict(true);
            return null;
        });
        // A rejected save goes back to the editor, where the banner and the buffer are.
        setReviewing(false);
        if (!updated) return;
        toast.success(`${updated.kind} “${updated.name}” updated`);
        exitEdit();
    };

    const handleDryRun = async () => {
        const checked = await replace.mutateAsync({ manifest: text, dryRun: true, expect }).catch(() => null);
        if (!checked) return;
        toast.success('Dry run passed', { description: `${checked.kind} “${checked.name}” is valid.` });
    };

    const reloadLatest = async () => {
        const { data } = await query.refetch();
        const freshYaml = data?.yaml;
        if (!freshYaml) return;
        setEdits(spliceResourceVersion(edits ?? freshYaml, freshYaml) ?? freshYaml);
        setConflict(false);
    };

    const handleCancel = () => {
        if (dirty) {
            setConfirmCancel(true);
            return;
        }
        exitEdit();
    };

    // One dialog serves both the in-panel Cancel and the navigation blocker.
    const discardOpen = confirmCancel || blocker.status === 'blocked';
    const closeDiscard = () => {
        setConfirmCancel(false);
        blocker.reset?.();
    };
    const discard = () => {
        setConfirmCancel(false);
        exitEdit();
        blocker.proceed?.();
    };

    if (query.isPending) {
        return (
            <div className={`${FRAME} gap-2 p-3.5`} data-testid="manifest-loading">
                {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-4 w-full" />
                ))}
            </div>
        );
    }

    if (query.isError) {
        const error = describeError(query.error);
        return (
            <div
                className={`${FRAME} items-center justify-center gap-3 p-6 text-center text-body text-text-muted`}
                data-testid="manifest-error"
            >
                <span>
                    {error.title}: {error.detail}
                </span>
                <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                    Retry
                </Button>
            </div>
        );
    }

    return (
        <div className={FRAME} data-testid="manifest-panel">
            <div className="flex items-center gap-2 border-b border-border py-1.5 pr-2 pl-3.5">
                {/* The buttons never shrink, so the label is what gives when the pane is narrow. */}
                <span className="min-w-0 truncate font-mono text-caption text-text-muted">
                    {editing ? 'Editing — Save replaces the live object' : `${liveKind} “${name}”`}
                </span>
                <div className="flex-1" />
                {editing ? (
                    <>
                        <Button
                            variant="ghost"
                            size="sm"
                            {...inertWhen(replace.isPending)}
                            onClick={() => {
                                if (replace.isPending) return;
                                handleCancel();
                            }}
                        >
                            <XIcon />
                            Cancel
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            {...inertWhen(empty || replace.isPending)}
                            onClick={() => {
                                if (empty || replace.isPending) return;
                                void handleDryRun();
                            }}
                        >
                            <EyeIcon />
                            Dry run
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            {...inertWhen(empty || replace.isPending)}
                            onClick={() => {
                                if (empty || replace.isPending) return;
                                setReviewing(true);
                            }}
                        >
                            <DiffIcon />
                            Review changes
                        </Button>
                        <Button
                            size="sm"
                            {...inertWhen(empty || replace.isPending)}
                            onClick={() => {
                                if (empty || replace.isPending) return;
                                void handleSave();
                            }}
                        >
                            <CheckIcon />
                            {replace.isPending ? 'Saving…' : 'Save'}
                        </Button>
                    </>
                ) : (
                    <>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => downloadTextFile(`${name}.yaml`, text, 'text/yaml')}
                        >
                            <DownloadIcon />
                            Download
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => void enterEdit()}>
                            <PencilIcon />
                            Edit
                        </Button>
                    </>
                )}
            </div>
            {editing && conflict && (
                <div
                    className="flex items-center gap-3 border-b border-border bg-warn-bg px-3.5 py-2 text-cell text-warn"
                    data-testid="manifest-conflict"
                >
                    <span className="min-w-0 flex-1">
                        This object changed on the server since you started editing. Reload to keep your edits and retry
                        Save.
                    </span>
                    <Button variant="outline" size="xs" onClick={() => void reloadLatest()}>
                        Reload latest
                    </Button>
                </div>
            )}
            <YamlEditor
                value={text}
                onValueChange={setEdits}
                readOnly={!editing}
                aria-label={`${liveKind} manifest`}
                className="min-h-0 flex-1"
            />
            <ManifestReview
                open={reviewing}
                onOpenChange={setReviewing}
                live={query.data?.yaml ?? ''}
                next={text}
                kind={liveKind ?? ''}
                name={name}
                saving={replace.isPending}
                onSave={() => void handleSave()}
            />
            <AlertDialog open={discardOpen} onOpenChange={(open) => !open && closeDiscard()}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
                        <AlertDialogDescription>
                            You have unsaved edits to{' '}
                            <span className="font-medium text-foreground">
                                {liveKind} “{name}”
                            </span>
                            . Discarding restores the live manifest.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel onClick={closeDiscard}>Keep editing</AlertDialogCancel>
                        <AlertDialogAction onClick={discard}>Discard</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
