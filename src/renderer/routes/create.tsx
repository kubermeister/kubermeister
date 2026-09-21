import { useRef, useState } from 'react';
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

function CreateResourcePage() {
    const { data: context } = useIpcQuery('context.current', {});
    const { data: namespace } = useIpcQuery('namespace.active', {});
    const navigateTo = useNavigateTo();
    const create = useCreateResource();
    const [text, setText] = useState('');
    // The template content last inserted verbatim — used to tell an untouched template apart from
    // one the user has edited (or their own pasted/imported manifest), so switching only warns when
    // it would actually discard work.
    const [pristine, setPristine] = useState('');
    // A pending template switch awaiting confirmation, or null when no dialog is open.
    const [pendingTemplate, setPendingTemplate] = useState<Template | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    // Under "All namespaces" nothing is stamped onto the manifest: a namespaced object must name
    // its own, or main refuses it rather than letting the client pick a default the user never saw.
    const allNamespaces = namespace !== undefined && namespace?.name === null;
    const scope = `${context?.name ?? '—'} / ${namespace?.name ?? (allNamespaces ? 'the namespace each manifest names' : '—')}`;
    const empty = text.trim().length === 0;

    const applyTemplate = (tpl: Template) => {
        setText(tpl.yaml);
        setPristine(tpl.yaml);
    };

    // Warn before replacing the editor only when there is unsaved work — non-empty content that
    // differs from the template we last inserted untouched.
    const requestTemplate = (id: string) => {
        const tpl = TEMPLATES.find((t) => t.id === id);
        if (!tpl) return;
        if (!empty && text !== pristine) {
            setPendingTemplate(tpl);
            return;
        }
        applyTemplate(tpl);
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

    const importFile = (file: File | undefined) => {
        if (!file) return;
        void file.text().then(setText);
    };

    return (
        <div className="flex h-full flex-col bg-background" data-testid="create-page">
            <div className="flex items-center gap-2 px-4.5 pt-3.5 pb-3">
                <div>
                    <div className="text-base font-semibold">Create resource</div>
                    <div className="text-cell text-text-muted">
                        Apply manifest to <span className="font-mono text-primary">{scope}</span>
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
                <input
                    ref={fileInput}
                    type="file"
                    accept=".yaml,.yml"
                    className="hidden"
                    onChange={(e) => {
                        importFile(e.target.files?.[0]);
                        e.target.value = '';
                    }}
                />
                <Button variant="ghost" size="sm" onClick={() => fileInput.current?.click()}>
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
                    placeholder={
                        'Paste a manifest, import a file, or insert a template.\n\napiVersion: apps/v1\nkind: Deployment\n…'
                    }
                    aria-label="YAML manifest"
                    className="h-full rounded-card border border-border focus-within:border-ring"
                />
            </div>
            <AlertDialog open={pendingTemplate !== null} onOpenChange={(open) => !open && setPendingTemplate(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Replace editor content?</AlertDialogTitle>
                        <AlertDialogDescription>
                            You have unsaved changes in the editor. Inserting the{' '}
                            <span className="font-medium text-foreground">{pendingTemplate?.label}</span> template will
                            discard them. This cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep editing</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                if (pendingTemplate) applyTemplate(pendingTemplate);
                                setPendingTemplate(null);
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
