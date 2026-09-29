import { useId, useState } from 'react';
import { ArrowLeftIcon, CheckIcon, EyeIcon, PackageIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
    releaseNameProblem,
    reviewProblem,
    type ChartReview,
    type ReleaseInstallResult,
} from '../../../shared/chart-install';
import { HelmRequired } from '@/components/chart/helm-required';
import { ChartValuesEditor } from '@/components/chart/values-editor';
import { InstallReview } from '@/components/chart/install-review';
import { NavLink, useNavigateTo } from '@/components/layout/nav-link';
import { UninstallReleaseButton } from '@/components/release/uninstall-release-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { describeError } from '@/lib/k8s-error';
import { useIpcQuery } from '@/lib/query';
import type { ValuesRenderError } from '@/lib/values-diagnostics';
import { rebaseValues, valueOverrides, valuesForRender } from '@/lib/values-validation';
import { useInstallRelease, useRenderChart } from '@/lib/writes';

/** The release path a finished install opens on. */
export const releasePath = (namespace: string, name: string) =>
    `/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;

function Notice({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
    return (
        <div className="m-4.5 rounded-card border border-border bg-card px-4 py-3.5" data-testid={testId}>
            <p className="text-body font-semibold">{title}</p>
            <div className="mt-1 text-cell text-text-2">{children}</div>
        </div>
    );
}

/**
 * Installing one chart version from a configured source: a release name, a version and the values,
 * into the active namespace; then a review of everything the render produced, each object through a
 * server-side dry run; then the install, which writes that very render. Helm renders and nothing
 * else, so without it this screen says so and offers nothing to do.
 */
export function InstallChart({
    source,
    chart,
    version,
    onVersionChange,
}: {
    source: string;
    chart: string;
    version: string;
    onVersionChange: (version: string) => void;
}) {
    const helm = useIpcQuery('helm.status', {});
    const { data: namespace } = useIpcQuery('namespace.active', {});
    const versions = useIpcQuery('charts.versions', { source, chart });
    const values = useIpcQuery('charts.values', { source, chart, version });
    const render = useRenderChart();
    const install = useInstallRelease();
    const navigateTo = useNavigateTo();
    const nameId = useId();

    const [name, setName] = useState(() => (releaseNameProblem(chart) ? '' : chart));
    const [text, setText] = useState('');
    // The chart defaults the text is an edit of. A version switch replaces untouched text and carries
    // an edit over to the new defaults; text that does not read stays an edit of the old ones, and
    // the review hands Helm only what it changed against them.
    const [base, setBase] = useState('');
    const [renderError, setRenderError] = useState<ValuesRenderError | null>(null);
    const [review, setReview] = useState<ChartReview | null>(null);
    const [failed, setFailed] = useState<ReleaseInstallResult | null>(null);
    const [loadedFor, setLoadedFor] = useState<string | null>(null);
    if (values.data && loadedFor !== version) {
        setLoadedFor(version);
        // Helm refused the other version's render; this one has not been asked yet.
        setRenderError(null);
        const carried = text === base ? values.data.valuesYaml : rebaseValues(text, base, values.data.valuesYaml);
        if (carried !== null) {
            setText(carried);
            setBase(values.data.valuesYaml);
        }
    }

    const target = namespace?.name ?? null;
    const nameProblem = name === '' ? null : releaseNameProblem(name);

    const heading = (
        <div className="flex items-center gap-2.5 px-4.5 pt-3.5 pb-3">
            <PackageIcon className="size-5 text-text-muted" />
            <div className="min-w-0">
                <div className="truncate text-base font-semibold">Install {chart}</div>
                <div className="text-cell text-text-muted">
                    From <span className="font-mono">{source}</span>
                    {target && (
                        <>
                            {' into '}
                            <span className="font-mono text-primary">{target}</span>
                        </>
                    )}
                </div>
            </div>
        </div>
    );

    if (helm.data && !helm.data.found) {
        return (
            <div className="flex h-full flex-col bg-background" data-testid="install-chart-page">
                {heading}
                <div
                    className="m-4.5 rounded-card border border-border bg-card px-4 py-3.5"
                    data-testid="install-no-helm"
                >
                    <HelmRequired />
                </div>
            </div>
        );
    }

    if (failed) {
        return (
            <div className="flex h-full flex-col bg-background" data-testid="install-chart-page">
                {heading}
                <Notice title={`Release “${failed.name}” failed to install`} testId="install-failed">
                    <p role="alert" className="text-danger">
                        {failed.message}
                    </p>
                    <p className="mt-2">
                        The release is recorded as failed, as Helm records it, and owns what was written before the
                        failure. Uninstall it to remove those objects, or open it to see what came up.
                    </p>
                    <div className="mt-3 flex gap-2">
                        <UninstallReleaseButton name={failed.name} namespace={failed.namespace} />
                        <Button variant="outline" size="sm" asChild>
                            <NavLink to={releasePath(failed.namespace, failed.name)}>Open release</NavLink>
                        </Button>
                    </div>
                </Notice>
            </div>
        );
    }

    const busy = render.isPending || install.isPending;
    const canReview = target !== null && name !== '' && nameProblem === null && values.data !== undefined && !busy;

    const runReview = async () => {
        if (!target || !values.data) return;
        const parsed = valuesForRender(text);
        if ('problem' in parsed) {
            toast.error('The values cannot be rendered', { description: parsed.problem });
            return;
        }
        // Helm reads the chart's own defaults itself, so it is handed only what the user changed.
        const overrides = valueOverrides(parsed.values, base);
        const outcome = await render
            .mutateAsync({ source, chart, version, name, namespace: target, values: overrides })
            .catch(() => null);
        if (!outcome) return;
        if (!outcome.rendered) {
            setRenderError({ values: text, message: outcome.message });
            return;
        }
        setRenderError(null);
        setReview(outcome.review);
    };

    const runInstall = async () => {
        if (!review) return;
        const result = await install.mutateAsync({ reviewId: review.reviewId }).catch(() => null);
        // Refused before anything was written; the toast has said why, and the review is spent.
        if (!result) {
            setReview(null);
            return;
        }
        if (result.status === 'failed') {
            setFailed(result);
            return;
        }
        toast.success(`Release “${result.name}” installed`, {
            description: `${chart} ${version} in ${result.namespace}`,
        });
        navigateTo(releasePath(result.namespace, result.name));
    };

    if (review) {
        return (
            <div className="flex h-full flex-col bg-background" data-testid="install-chart-page">
                <div className="flex items-center gap-2 pr-4.5">
                    {heading}
                    <div className="flex-1" />
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setReview(null)}>
                        <ArrowLeftIcon />
                        Back to values
                    </Button>
                    <Button
                        size="sm"
                        disabled={busy || reviewProblem(review) !== null}
                        onClick={() => void runInstall()}
                    >
                        <CheckIcon />
                        {install.isPending ? 'Installing…' : `Install ${review.name}`}
                    </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto px-4.5 pb-4.5">
                    <InstallReview review={review} />
                </div>
            </div>
        );
    }

    const versionList = versions.data ?? [version];
    return (
        <div className="flex h-full flex-col bg-background" data-testid="install-chart-page">
            <div className="flex items-end gap-3 pr-4.5">
                {heading}
                <div className="flex-1" />
                <div className="flex flex-col gap-1 pb-3">
                    <Label htmlFor={nameId} className="text-meta text-text-muted">
                        Release name
                    </Label>
                    <Input
                        id={nameId}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        aria-invalid={nameProblem !== null}
                        className="h-8 w-56 font-mono"
                        spellCheck={false}
                    />
                </div>
                <div className="flex flex-col gap-1 pb-3">
                    <span className="text-meta text-text-muted">Version</span>
                    <Select value={version} onValueChange={onVersionChange} disabled={versions.data === null || busy}>
                        <SelectTrigger size="sm" className="w-36 font-mono" aria-label="Chart version">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {(versionList.includes(version) ? versionList : [version, ...versionList]).map((one) => (
                                <SelectItem key={one} value={one} className="font-mono">
                                    {one}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="pb-3">
                    <Button size="sm" disabled={!canReview} onClick={() => void runReview()}>
                        <EyeIcon />
                        {render.isPending ? 'Rendering…' : 'Review'}
                    </Button>
                </div>
            </div>
            {nameProblem && (
                <p className="px-4.5 pb-2 text-cell text-danger" data-testid="install-name-problem">
                    {nameProblem}
                </p>
            )}
            {namespace !== undefined && target === null && (
                <p className="px-4.5 pb-2 text-cell text-warn" data-testid="install-all-namespaces">
                    A chart installs into one namespace. Choose it in the namespace selector: “All namespaces” is not
                    one.
                </p>
            )}
            <div className="min-h-0 flex-1 px-4.5 pb-4.5">
                {values.error ? (
                    <Notice title={describeError(values.error).title} testId="install-values-error">
                        {describeError(values.error).detail}
                    </Notice>
                ) : values.data ? (
                    <ChartValuesEditor
                        chart={values.data}
                        value={text}
                        onValueChange={setText}
                        renderError={renderError}
                        className="h-full overflow-hidden rounded-card border border-border focus-within:border-ring"
                    />
                ) : (
                    <p className="p-4 text-cell text-text-muted">
                        Fetching {chart} {version}…
                    </p>
                )}
            </div>
        </div>
    );
}
