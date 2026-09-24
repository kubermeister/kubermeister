import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { CheckIcon, EyeIcon, UploadIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { YamlEditor } from '@/components/data-display/yaml-editor';
import { useNavigateTo } from '@/components/layout/nav-link';
import { invoke } from '@/lib/ipc';
import { useManifestChecks } from '@/lib/manifest-diagnostics';
import { clearStagedManifest, importFailed, useStagedManifest } from '@/lib/manifest-import';
import { useIpcQuery } from '@/lib/query';
import { TEMPLATES, type Template } from '@/lib/create-templates';
import { useCreateResource } from '@/lib/writes';
import { KINDS, KIND_REGISTRY } from '../../shared/k8s/registry';

export const Route = createFileRoute('/create')({ component: CreateResourcePage });

/**
 * Where to land once an object exists, taken from the kind registry so the two cannot drift. A kind
 * the app does not model leaves the page where it is.
 */
const KIND_LIST_PATHS: Record<string, string> = Object.fromEntries(
    KINDS.map((kind) => [kind, KIND_REGISTRY[kind].listPath]),
);

/**
 * Something about to take the editor's place: a template or a file. Both replace everything in
 * there, so both ask first when there is work to lose, and `from` is what the question names.
 */
interface Replacement {
    yaml: string;
    from: string;
    kind: 'template' | 'file';
}

function CreateResourcePage() {
    const { data: context } = useIpcQuery('context.current', {});
    const { data: namespace } = useIpcQuery('namespace.active', {});
    const navigateTo = useNavigateTo();
    const create = useCreateResource();
    const [text, setText] = useState('');
    const checks = useManifestChecks(text);
    // The content last inserted verbatim — used to tell an untouched template or a freshly opened
    // file apart from one the user has edited (or their own pasted manifest), so a replacement only
    // warns when it would actually discard work.
    const [pristine, setPristine] = useState('');
    // The file the editor's content was read from, which is the one thing about a manifest that is
    // not in the manifest; cleared as soon as a template takes its place.
    const [source, setSource] = useState<string | null>(null);
    // A pending replacement awaiting confirmation, or null when no dialog is open.
    const [pending, setPending] = useState<Replacement | null>(null);
    // Under "All namespaces" nothing is stamped onto the manifest: a namespaced object must name
    // its own, or main refuses it rather than letting the client pick a default the user never saw.
    const allNamespaces = namespace !== undefined && namespace?.name === null;
    const scope = `${context?.name ?? '—'} / ${namespace?.name ?? (allNamespaces ? 'the namespace each manifest names' : '—')}`;
    const empty = text.trim().length === 0;

    const apply = (next: Replacement) => {
        setText(next.yaml);
        setPristine(next.yaml);
        setSource(next.kind === 'file' ? next.from : null);
    };

    // Warn before replacing the editor only when there is unsaved work — non-empty content that
    // differs from what we last inserted untouched.
    const request = (next: Replacement) => {
        if (!empty && text !== pristine) {
            setPending(next);
            return;
        }
        apply(next);
    };

    const requestTemplate = (id: string) => {
        const tpl: Template | undefined = TEMPLATES.find((t) => t.id === id);
        if (tpl) request({ yaml: tpl.yaml, from: tpl.label, kind: 'template' });
    };

    // A file dropped on any screen is read by main and staged by the shell, which then opens this
    // page; it is taken here during render so the editor never paints without it.
    const staged = useStagedManifest();
    const [importedSeq, setImportedSeq] = useState(0);
    if (staged && staged.seq !== importedSeq) {
        setImportedSeq(staged.seq);
        request({ yaml: staged.text, from: staged.name, kind: 'file' });
    }
    useEffect(() => {
        if (staged) clearStagedManifest();
    }, [staged]);

    /** The other way in: the OS file dialog, which main opens and reads. A cancelled picker is null. */
    const openFromDisk = async () => {
        const file = await invoke('manifest.pick', {}).catch((error: unknown) => {
            importFailed(error);
            return null;
        });
        if (file) request({ yaml: file.text, from: file.name, kind: 'file' });
    };

    // Rejections are already surfaced by the global mutation toast — swallow and skip navigation.
    const handleCreate = async () => {
        const created = await create.mutateAsync({ manifest: text }).catch(() => null);
        if (!created) return;
        toast.success(`${created.kind} “${created.name}” created`, {
            description: created.namespace ? `in namespace ${created.namespace}` : undefined,
        });
        const listPath = KIND_LIST_PATHS[created.kind];
        if (listPath) navigateTo(listPath);
    };

    const handleDryRun = async () => {
        const checked = await create.mutateAsync({ manifest: text, dryRun: true }).catch(() => null);
        if (!checked) return;
        toast.success('Dry run passed', { description: `${checked.kind} “${checked.name}” is valid.` });
    };

    return (
        <div className="flex h-full flex-col bg-background" data-testid="create-page">
            <div className="flex items-center gap-2 px-4.5 pt-3.5 pb-3">
                <div>
                    <div className="text-base font-semibold">Create resource</div>
                    <div className="text-cell text-text-muted">
                        Apply manifest to <span className="font-mono text-primary">{scope}</span>
                        {source && (
                            <>
                                {' · from '}
                                <span className="font-mono">{source}</span>
                            </>
                        )}
                    </div>
                </div>
                <div className="flex-1" />
                <Select value="" onValueChange={requestTemplate}>
                    <SelectTrigger size="sm" className="w-[180px]" aria-label="Insert template">
                        <SelectValue placeholder="Insert template…" />
                    </SelectTrigger>
                    <SelectContent>
                        {TEMPLATES.map((tpl) => (
                            <SelectItem key={tpl.id} value={tpl.id}>
                                {/* The space is literal, not a margin: it separates the two in the
                                    accessible name, where "Service" and "ServiceAccount" otherwise
                                    read as one word run together with their api version. */}
                                {tpl.label} <span className="font-mono text-caption text-text-muted">{tpl.api}</span>
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Button variant="ghost" size="sm" onClick={() => void openFromDisk()}>
                    <UploadIcon />
                    Import
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    disabled={empty || create.isPending}
                    onClick={() => void handleDryRun()}
                >
                    <EyeIcon />
                    Dry run
                </Button>
                <Button size="sm" disabled={empty || create.isPending} onClick={() => void handleCreate()}>
                    <CheckIcon />
                    {create.isPending ? 'Applying…' : 'Create'}
                </Button>
            </div>
            <div className="min-h-0 flex-1 px-4.5 pb-4.5">
                <YamlEditor
                    value={text}
                    onValueChange={setText}
                    diagnostics={checks.diagnostics}
                    schema={checks.schema}
                    placeholder={
                        'Paste a manifest, drop a file on the window, or insert a template.\n\napiVersion: apps/v1\nkind: Deployment\n…'
                    }
                    aria-label="YAML manifest"
                    className="h-full rounded-card border border-border focus-within:border-ring"
                />
            </div>
            <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Replace editor content?</AlertDialogTitle>
                        <AlertDialogDescription>
                            You have unsaved changes in the editor.{' '}
                            {pending?.kind === 'file' ? 'Opening ' : 'Inserting the '}
                            <span className="font-medium text-foreground">{pending?.from}</span>
                            {pending?.kind === 'file' ? '' : ' template'} will discard them. This cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep editing</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                if (pending) apply(pending);
                                setPending(null);
                            }}
                        >
                            Replace
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
