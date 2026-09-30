import { useId, useState } from 'react';
import { CheckIcon, Loader2Icon } from 'lucide-react';
import { CHART_NAME, CHART_VERSION, type ChartRepositoryStatus } from '../../../shared/charts';
import { HelmRequired } from '@/components/chart/helm-required';
import { NavLink, useNavigateTo } from '@/components/layout/nav-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useChartRepositories } from '@/lib/chart-repositories';
import { useIpcQuery } from '@/lib/query';

/** The install screen for one chart version. */
export const installChartPath = (source: string, chart: string, version: string) =>
    `/helm/charts/install/${[source, chart, version].map(encodeURIComponent).join('/')}`;

/** Where a repository is added, named the way the docs and the empty states name it. */
function SettingsLink({ onNavigate }: { onNavigate: () => void }) {
    return (
        <NavLink to="/settings/charts" onClick={onNavigate} className="text-primary underline">
            Settings › Charts
        </NavLink>
    );
}

/**
 * The way into an install from anywhere that does not already name a chart version: pick the source,
 * then the chart, and the install screen opens on its latest version, where the version can still be
 * changed. A classic repository's charts are picked from its cached index; an OCI registry publishes
 * no index, so its chart and version are typed, as `helm pull oci://…` takes them. Without Helm it
 * says so and opens nothing, since the screen behind it could not render.
 */
export function InstallChartDialog({
    open,
    onOpenChange,
    repository: givenRepository,
    chart: givenChart,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The source to install from, when the entry point already knows it. */
    repository?: string;
    /** The chart to install, when the entry point already knows it; only with `repository`. */
    chart?: string;
}) {
    const helm = useIpcQuery('helm.status', {}, { enabled: open });
    const [picked, setPicked] = useState<string | null>(null);
    const [chart, setChart] = useState('');
    const [version, setVersion] = useState('');

    const close = (next: boolean) => {
        if (!next) {
            setPicked(null);
            setChart('');
            setVersion('');
        }
        onOpenChange(next);
    };

    return (
        <Dialog open={open} onOpenChange={close}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Install a chart</DialogTitle>
                    <DialogDescription>
                        Choose a chart from a configured repository; its values and a review come next.
                    </DialogDescription>
                </DialogHeader>
                {helm.data === undefined ? (
                    <p className="flex items-center gap-2 text-cell text-text-muted">
                        <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
                        Looking for Helm…
                    </p>
                ) : !helm.data.found ? (
                    <HelmRequired>
                        <Button
                            variant="outline"
                            size="sm"
                            className="mt-3"
                            disabled={helm.isFetching}
                            onClick={() => void helm.refetch()}
                        >
                            Check again
                        </Button>
                    </HelmRequired>
                ) : (
                    <ChartPicker
                        repository={givenRepository ?? picked}
                        onRepositoryChange={
                            givenRepository === undefined
                                ? (next) => {
                                      setPicked(next);
                                      setChart('');
                                      setVersion('');
                                  }
                                : undefined
                        }
                        givenChart={givenChart}
                        chart={chart}
                        onChartChange={setChart}
                        version={version}
                        onVersionChange={setVersion}
                        onClose={() => close(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function ChartPicker({
    repository: name,
    onRepositoryChange,
    givenChart,
    chart,
    onChartChange,
    version,
    onVersionChange,
    onClose,
}: {
    repository: string | null;
    onRepositoryChange?: (name: string) => void;
    givenChart?: string;
    chart: string;
    onChartChange: (chart: string) => void;
    version: string;
    onVersionChange: (version: string) => void;
    onClose: () => void;
}) {
    const navigateTo = useNavigateTo();
    const repositories = useChartRepositories();
    const charts = useIpcQuery('charts.list', {});
    const chartId = useId();
    const versionId = useId();

    if (repositories.data === undefined) {
        return <p className="text-cell text-text-muted">Reading the chart repositories…</p>;
    }
    if (repositories.data.length === 0) {
        return (
            <p className="text-cell text-text-2" data-testid="install-chart-no-repositories">
                No chart repository is configured. Add one under <SettingsLink onNavigate={onClose} /> to install the
                charts it publishes.
            </p>
        );
    }

    const source = repositories.data.find((one) => one.name === name) ?? null;
    const oci = source?.kind === 'oci';
    const own = (charts.data ?? []).filter((one) => one.repository === source?.name);
    const chosen = givenChart ?? chart;
    const latest = own.find((one) => one.name === chosen)?.latestVersion;

    const problem = oci
        ? chart !== '' && !CHART_NAME.test(chart)
            ? `“${chart}” is not a chart name.`
            : version !== '' && !CHART_VERSION.test(version)
              ? `“${version}” is not a chart version.`
              : null
        : null;
    const target = !source
        ? null
        : oci
          ? chart !== '' && version !== '' && problem === null
              ? { chart, version }
              : null
          : latest
            ? { chart: chosen, version: latest }
            : null;

    const proceed = () => {
        if (!source || !target) return;
        onClose();
        navigateTo(installChartPath(source.name, target.chart, target.version));
    };

    return (
        <>
            <div className="flex flex-col gap-3">
                {onRepositoryChange ? (
                    <Select value={source?.name ?? ''} onValueChange={onRepositoryChange}>
                        <SelectTrigger aria-label="Repository" className="w-full">
                            <SelectValue placeholder="Choose a repository" />
                        </SelectTrigger>
                        <SelectContent>
                            {repositories.data.map((one) => (
                                <SelectItem key={one.name} value={one.name}>
                                    <RepositoryLabel repository={one} />
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                ) : (
                    source && (
                        <div className="text-cell text-text-muted">
                            From <RepositoryLabel repository={source} />
                        </div>
                    )
                )}

                {source && givenChart !== undefined && (
                    <div className="text-cell">
                        <span className="font-mono">{givenChart}</span>
                        {latest && <span className="text-text-muted"> {latest}</span>}
                    </div>
                )}

                {source && givenChart === undefined && oci && (
                    <div className="grid grid-cols-[1fr_10rem] gap-2.5">
                        <div className="flex flex-col gap-1">
                            <Label htmlFor={chartId} className="text-meta text-text-muted">
                                Chart name
                            </Label>
                            <Input
                                id={chartId}
                                value={chart}
                                onChange={(event) => onChartChange(event.target.value.trim())}
                                placeholder="podinfo"
                                className="font-mono"
                                spellCheck={false}
                                autoFocus
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <Label htmlFor={versionId} className="text-meta text-text-muted">
                                Chart version
                            </Label>
                            <Input
                                id={versionId}
                                value={version}
                                onChange={(event) => onVersionChange(event.target.value)}
                                placeholder="1.0.0"
                                className="font-mono"
                                spellCheck={false}
                            />
                        </div>
                        <p className="col-span-2 text-meta text-text-muted">
                            A registry publishes no list of its charts, so name the one to install.
                        </p>
                    </div>
                )}

                {source &&
                    givenChart === undefined &&
                    !oci &&
                    (charts.data !== undefined && own.length === 0 ? (
                        <p className="text-cell text-text-2" data-testid="install-chart-no-charts">
                            <span className="font-mono">{source.name}</span> lists no charts. Refresh it under{' '}
                            <SettingsLink onNavigate={onClose} />.
                        </p>
                    ) : (
                        <Command className="rounded-md border border-border">
                            <CommandInput placeholder="Search charts…" />
                            <CommandList className="max-h-64" data-testid="install-chart-picker">
                                <CommandEmpty>No chart matches.</CommandEmpty>
                                {own.map((one) => (
                                    <CommandItem
                                        key={one.name}
                                        value={one.name}
                                        onSelect={() => onChartChange(one.name)}
                                    >
                                        <CheckIcon
                                            className={
                                                one.name === chart ? 'size-3.5 text-primary' : 'size-3.5 opacity-0'
                                            }
                                            aria-hidden
                                        />
                                        <span className="font-mono">{one.name}</span>
                                        <span className="font-mono text-text-muted">{one.latestVersion}</span>
                                        <span className="min-w-0 flex-1 truncate text-text-muted">
                                            {one.description}
                                        </span>
                                    </CommandItem>
                                ))}
                            </CommandList>
                        </Command>
                    ))}

                {problem && (
                    <p className="text-cell text-danger" data-testid="install-chart-problem">
                        {problem}
                    </p>
                )}
            </div>
            <DialogFooter>
                <Button variant="outline" onClick={onClose}>
                    Cancel
                </Button>
                <Button disabled={target === null} onClick={proceed}>
                    Continue
                </Button>
            </DialogFooter>
        </>
    );
}

function RepositoryLabel({ repository }: { repository: ChartRepositoryStatus }) {
    return (
        <span className="inline-flex items-center gap-1.5">
            <span className="font-medium text-foreground">{repository.name}</span>
            <Badge variant={repository.kind === 'oci' ? 'accent' : 'neutral'}>
                {repository.kind === 'oci' ? 'OCI' : 'Classic'}
            </Badge>
        </span>
    );
}
