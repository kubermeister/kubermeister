import { useState } from 'react';
import { KeyRoundIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import {
    CHART_REPOSITORY_NAME,
    chartRepositoryUrlProblem,
    sendsCredentialsInClear,
    type ChartRepositoryKind,
    type ChartRepositoryStatus,
} from '../../../shared/charts';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FormCard } from '@/components/templates/settings-form';
import {
    useAddChartRepository,
    useChartRepositories,
    useRefreshChartRepository,
    useRemoveChartRepository,
} from '@/lib/chart-repositories';
import { cn } from '@/lib/utils';

/**
 * Where charts come from, configured once for this install. A classic repository is read by
 * downloading its index, which is cached on disk; an OCI registry publishes no index, so all a
 * refresh can do for one is check that it answers and still accepts its credential.
 */

const KIND_OPTIONS: { value: ChartRepositoryKind; label: string; desc: string; placeholder: string }[] = [
    {
        value: 'classic',
        label: 'Classic repository',
        desc: 'Serves an index.yaml',
        placeholder: 'https://charts.example.com',
    },
    { value: 'oci', label: 'OCI registry', desc: 'Charts as OCI artifacts', placeholder: 'oci://ghcr.io/example' },
];

export function ChartRepositoriesCard() {
    const repositories = useChartRepositories();
    const rows = repositories.data ?? [];

    return (
        <FormCard
            title="Chart repositories"
            desc="Sources Kubermeister reads charts from. Passwords are kept in this system's keychain, never in the settings file."
            action={<AddRepositoryDialog />}
        >
            <div data-testid="chart-repositories">
                {rows.length === 0 ? (
                    <p className="text-cell text-text-muted">
                        No chart repositories yet. Add one to read the charts it publishes.
                    </p>
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-[170px]">Name</TableHead>
                                <TableHead>Source</TableHead>
                                <TableHead className="w-[80px] text-right">Charts</TableHead>
                                <TableHead className="w-[150px]">Last read</TableHead>
                                <TableHead className="w-[80px] text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((repository) => (
                                <RepositoryRow key={repository.name} repository={repository} />
                            ))}
                        </TableBody>
                    </Table>
                )}
            </div>
        </FormCard>
    );
}

function RepositoryRow({ repository }: { repository: ChartRepositoryStatus }) {
    const refresh = useRefreshChartRepository();
    const remove = useRemoveChartRepository();
    const { name, kind, url, hasCredentials, chartCount, refreshedAt } = repository;

    const runRefresh = async () => {
        const read = await refresh.mutateAsync({ name }).catch(() => null);
        if (read) toast.success(`“${name}” read`, { description: describeRead(read) });
    };

    return (
        <TableRow data-testid={`repository-${name}`}>
            <TableCell>
                <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{name}</span>
                    {hasCredentials && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span data-testid={`repository-credentials-${name}`} tabIndex={0}>
                                    <KeyRoundIcon className="size-3 text-text-muted" aria-label="Has a credential" />
                                </span>
                            </TooltipTrigger>
                            <TooltipContent>A username and password are held in the keychain</TooltipContent>
                        </Tooltip>
                    )}
                </div>
            </TableCell>
            <TableCell className="max-w-0">
                <div className="flex items-center gap-2">
                    <Badge variant={kind === 'oci' ? 'accent' : 'neutral'}>{kind === 'oci' ? 'OCI' : 'Classic'}</Badge>
                    <span className="truncate font-mono text-text-muted" title={url}>
                        {url}
                    </span>
                </div>
            </TableCell>
            <TableCell className="text-right font-mono">{chartCount ?? '—'}</TableCell>
            <TableCell className="text-text-muted">
                {refreshedAt ? new Date(refreshedAt).toLocaleString() : 'Never'}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap">
                <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Refresh ${name}`}
                    disabled={refresh.isPending}
                    onClick={() => void runRefresh()}
                >
                    <RefreshCwIcon className={cn(refresh.isPending && 'animate-spin')} />
                </Button>
                <AlertDialog>
                    <AlertDialogTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Remove ${name}`}
                            disabled={remove.isPending}
                        >
                            <Trash2Icon />
                        </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Remove “{name}”?</AlertDialogTitle>
                            <AlertDialogDescription>
                                Its cached index and any credential stored for it go with it. Nothing in the cluster
                                changes.
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => void remove.mutateAsync({ name }).catch(() => null)}>
                                Remove
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </TableCell>
        </TableRow>
    );
}

/** What a read found, which for a registry is that it answered at all. */
function describeRead(repository: ChartRepositoryStatus): string {
    return repository.chartCount === null
        ? 'The registry answered.'
        : `${repository.chartCount.toLocaleString()} charts`;
}

function AddRepositoryDialog() {
    const [open, setOpen] = useState(false);
    const [kind, setKind] = useState<ChartRepositoryKind>('classic');
    const [name, setName] = useState('');
    const [url, setUrl] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const add = useAddChartRepository();

    // The same rules main enforces at the boundary, said here so a typo is answered before a round trip.
    const urlProblem = url === '' ? null : chartRepositoryUrlProblem(kind, url);
    const credentialProblem =
        username !== '' && password === ''
            ? 'Give a username and a password together.'
            : password !== '' && username === ''
              ? 'Give a username and a password together.'
              : password !== '' && sendsCredentialsInClear(url)
                ? 'A password needs an https URL.'
                : null;
    const problem = urlProblem ?? credentialProblem;
    const ready = CHART_REPOSITORY_NAME.test(name) && url !== '' && problem === null;

    const submit = async () => {
        const credential = username !== '' && password !== '' ? { username, password } : {};
        const added = await add.mutateAsync({ name, kind, url, ...credential }).catch(() => null);
        if (!added) return;
        toast.success(`“${added.name}” added`, { description: describeRead(added) });
        setOpen(false);
        setName('');
        setUrl('');
        setUsername('');
        setPassword('');
    };

    return (
        <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" data-testid="add-chart-repository">
                    <PlusIcon />
                    Add repository
                </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Add a chart repository</AlertDialogTitle>
                    <AlertDialogDescription>
                        Kubermeister reads the source once to check it answers, then remembers it.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-2.5" role="radiogroup" aria-label="Source kind">
                        {KIND_OPTIONS.map((option) => {
                            const selected = kind === option.value;
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    role="radio"
                                    aria-checked={selected}
                                    onClick={() => setKind(option.value)}
                                    className={cn(
                                        'flex flex-col items-start gap-0.5 rounded-md border-[1.5px] p-2.5 text-left transition-colors',
                                        selected
                                            ? 'border-primary bg-accent-bg'
                                            : 'border-border bg-elev-2 hover:border-border-hi',
                                    )}
                                >
                                    <span className="text-body font-medium">{option.label}</span>
                                    <span className="text-label text-text-muted">{option.desc}</span>
                                </button>
                            );
                        })}
                    </div>
                    <Input
                        autoFocus
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="bitnami"
                        aria-label="Repository name"
                    />
                    <Input
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                        placeholder={KIND_OPTIONS.find((option) => option.value === kind)?.placeholder}
                        aria-label="Repository URL"
                    />
                    <div className="grid grid-cols-2 gap-2.5">
                        <Input
                            value={username}
                            onChange={(event) => setUsername(event.target.value)}
                            placeholder="Username (optional)"
                            aria-label="Username"
                            autoComplete="off"
                        />
                        <Input
                            type="password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            placeholder="Password (optional)"
                            aria-label="Password"
                            autoComplete="off"
                        />
                    </div>
                    {problem && <p className="text-cell text-danger">{problem}</p>}
                </div>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction disabled={!ready || add.isPending} onClick={() => void submit()}>
                        Add
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
