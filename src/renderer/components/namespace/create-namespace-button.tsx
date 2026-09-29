import { useState } from 'react';
import { PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isNamespaceName } from '../../../shared/k8s/names';
import { useCreateResource } from '@/lib/writes';

/**
 * A namespace is the one object worth creating from a name alone: it has no spec anybody fills in,
 * so the editor's blank manifest would be four lines of boilerplate around that name. Anything
 * richer still belongs in Create resource.
 */
export function CreateNamespaceButton() {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const create = useCreateResource();
    // The API server refuses a name that is not a DNS label, and saying so here beats a round trip.
    const valid = isNamespaceName(name);

    const submit = async () => {
        const manifest = `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${name}\n`;
        const created = await create.mutateAsync({ manifest }).catch(() => null);
        if (!created) return;
        toast.success(`Namespace “${created.name}” created`);
        setOpen(false);
        setName('');
    };

    return (
        <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogTrigger asChild>
                <Button variant="outline" size="xs" data-testid="create-namespace">
                    <PlusIcon />
                    New namespace
                </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>New namespace</AlertDialogTitle>
                    <AlertDialogDescription>
                        Names are DNS labels: lowercase letters, digits and dashes.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <Input
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="team-a"
                    aria-label="Namespace name"
                />
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                        disabled={!valid || create.isPending}
                        onClick={(event) => {
                            // Keep the dialog open, with what was typed, until the write settles: a refusal leaves it
                            // up to be corrected rather than only a toast.
                            event.preventDefault();
                            void submit();
                        }}
                    >
                        Create
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
