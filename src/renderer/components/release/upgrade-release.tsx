import { useId, useState } from 'react';
import { ArrowLeftIcon, CheckIcon, EyeIcon, RocketIcon } from 'lucide-react';
import { toast } from 'sonner';
import { type ReleaseInstallResult } from '../../../shared/chart-install';
import { upgradeProblem, type ChartUpgradeReview } from '../../../shared/chart-upgrade';
import { HELM_INSTALL_URL } from '../../../shared/helm-tool';
import { releasePath } from '@/components/chart/install-chart';
import { ChartValuesEditor } from '@/components/chart/values-editor';
import { NavLink, useNavigateTo } from '@/components/layout/nav-link';
import { UpgradeReview } from '@/components/release/upgrade-review';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { describeError } from '@/lib/k8s-error';
import { useIpcQueries, useIpcQuery } from '@/lib/query';
import type { ValuesRenderError } from '@/lib/values-diagnostics';
import { valuesForRender } from '@/lib/values-validation';
import { useRenderUpgrade, useUpgradeRelease } from '@/lib/writes';

/** Where a release's upgrade starts. */
export const upgradePath = (namespace: string, name: string) => `${releasePath(namespace, name)}/upgrade`;

/** The chart an upgrade renders: a source, a chart in it and one of its versions. Unset is the default. */
export interface UpgradePick {
    source?: string;
    chart?: string;
    version?: string;
}

function Notice({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
    return (
        <div className="m-4.5 rounded-card border border-border bg-card px-4 py-3.5" data-testid={testId}>
            <p className="text-body font-semibold">{title}</p>
            <div className="mt-1 text-cell text-text-2">{children}</div>
        </div>
    );
}

/**
 * The source an upgrade starts from when nobody picked one. A release does not record where its chart
 * came from, so it is the first classic repository whose index lists a chart of that name, else the
 * first registry, which lists nothing to ask; undefined while the repositories are still answering.
 */
export function defaultSource(
    repositories: { name: string; kind: 'classic' | 'oci' }[],
    listed: { source: string; versions: string[] | null | undefined; settled: boolean }[],
): string | undefined {
    for (const one of listed) {
        if (!one.settled) return undefined;
        if (one.versions && one.versions.length > 0) return one.source;
    }
    return repositories.find((one) => one.kind === 'oci')?.name ?? repositories[0]?.name;
}

/**
 * Upgrading one release: a chart version from a configured source, and the values, starting from the
 * current revision's own; then a review of what the upgrade changes, the values and every object
 * diffed against what is there now; then the upgrade, which writes that very render as a new
 * revision. Helm renders and nothing else, so without it this screen says so and offers nothing.
 */
export function UpgradeRelease({ namespace, name }: { namespace: string; name: string }) {
    const [pick, onPick] = useState<UpgradePick>({});
    const helm = useIpcQuery('helm.status', {});
    const release = useIpcQuery('releases.get', { name, namespace });
    const repositories = useIpcQuery('chartRepositories.list', {});
    const renderUpgrade = useRenderUpgrade();
    const upgrade = useUpgradeRelease();
    const navigateTo = useNavigateTo();
    const chartId = useId();
    const versionId = useId();

    const chart = pick.chart ?? release.data?.chartName ?? '';
    const sources = repositories.data ?? [];
    const classic = pick.source || chart === '' ? [] : sources.filter((one) => one.kind === 'classic');
    const probes = useIpcQueries(
        'charts.versions',
        classic.map((one) => ({ source: one.name, chart })),
    );
    const source =
        pick.source ??
        (repositories.data
            ? defaultSource(
                  sources,
                  classic.map((one, i) => ({
                      source: one.name,
                      versions: probes[i]?.data,
                      settled: !probes[i]?.isPending,
                  })),
              )
            : undefined);
    const ready = source !== undefined && chart !== '';
    const versions = useIpcQuery('charts.versions', { source: source ?? '', chart }, { enabled: ready });
    // A registry lists no versions, so it starts from the one the release runs.
    const version =
        pick.version ??
        (versions.data ? versions.data[0] : versions.data === null ? release.data?.chartVersion : undefined);
    const values = useIpcQuery(
        'charts.values',
        { source: source ?? '', chart, version: version ?? '' },
        { enabled: ready && !!version },
    );

    const [text, setText] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [versionDraft, setVersionDraft] = useState<string | null>(null);
    // Helm's refusal of one chart version's render, which says nothing about another's.
    const [renderError, setRenderError] = useState<{ key: string; error: ValuesRenderError } | null>(null);
    const [review, setReview] = useState<ChartUpgradeReview | null>(null);
    const [failed, setFailed] = useState<ReleaseInstallResult | null>(null);
    if (release.data && !loaded) {
        setLoaded(true);
        setText(release.data.values ?? '');
    }

    const heading = (
        <div className="flex items-center gap-2.5 px-4.5 pt-3.5 pb-3">
            <RocketIcon className="size-5 text-text-muted" />
            <div className="min-w-0">
                <div className="truncate text-base font-semibold">Upgrade {name}</div>
                <div className="text-cell text-text-muted">
                    <span className="font-mono">{release.data?.chart ?? '…'}</span>
                    {release.data && <> at revision {release.data.revision}</>}
                    {' in '}
                    <span className="font-mono text-primary">{namespace}</span>
                </div>
            </div>
        </div>
    );
    const page = (children: React.ReactNode) => (
        <div className="flex h-full flex-col bg-background" data-testid="upgrade-release-page">
            {children}
        </div>
    );

    if (helm.data && !helm.data.found) {
        return page(
            <>
                {heading}
                <Notice title="Helm is required to upgrade a release" testId="upgrade-no-helm">
                    Kubermeister renders a chart with the <span className="font-mono">helm</span> installed on this
                    machine, using <span className="font-mono">helm template</span> and nothing else, and none was found
                    on the PATH.{' '}
                    <a href={HELM_INSTALL_URL} target="_blank" rel="noreferrer" className="text-primary underline">
                        Install Helm 3 or later
                    </a>
                    , then open this screen again.
                </Notice>
            </>,
        );
    }
    if (release.error) {
        return page(
            <>
                {heading}
                <Notice title={describeError(release.error).title} testId="upgrade-release-error">
                    {describeError(release.error).detail}
                </Notice>
            </>,
        );
    }
    if (release.data === null) {
        return page(
            <Notice title="Release not found" testId="upgrade-release-missing">
                No Helm release named <span className="font-mono">{name}</span> in namespace{' '}
                <span className="font-mono">{namespace}</span>.
            </Notice>,
        );
    }
    if (repositories.data && sources.length === 0) {
        return page(
            <>
                {heading}
                <Notice title="No chart repository to upgrade from" testId="upgrade-no-sources">
                    A release does not record where its chart came from, so an upgrade takes the chart from a
                    repository or registry configured under{' '}
                    <NavLink to="/settings" className="text-primary underline">
                        Settings › Charts
                    </NavLink>
                    . Add the one this chart is published in, then open this screen again.
                </Notice>
            </>,
        );
    }
    if (failed) {
        return page(
            <>
                {heading}
                <Notice title={`Upgrade of “${failed.name}” failed`} testId="upgrade-failed">
                    <p role="alert" className="text-danger">
                        {failed.message}
                    </p>
                    <p className="mt-2">
                        Revision {failed.revision} is recorded as failed, as Helm records it, and the revision before it
                        is still the deployed one. Open the release to see what came up, or roll it back from its
                        Revisions tab.
                    </p>
                    <div className="mt-3 flex gap-2">
                        <Button variant="outline" size="sm" asChild>
                            <NavLink to={releasePath(failed.namespace, failed.name)}>Open release</NavLink>
                        </Button>
                    </div>
                </Notice>
            </>,
        );
    }

    const busy = renderUpgrade.isPending || upgrade.isPending;
    const pickKey = `${source}/${chart}/${version}`;
    const canReview = ready && !!version && values.data !== undefined && !busy;

    const runReview = async () => {
        if (!source || !version) return;
        const parsed = valuesForRender(text);
        if ('problem' in parsed) {
            toast.error('The values cannot be rendered', { description: parsed.problem });
            return;
        }
        const outcome = await renderUpgrade
            .mutateAsync({ source, chart, version, name, namespace, values: parsed.values })
            .catch(() => null);
        if (!outcome) return;
        if (!outcome.rendered) {
            setRenderError({ key: pickKey, error: { values: text, message: outcome.message } });
            return;
        }
        setRenderError(null);
        setReview(outcome.review);
    };

    const runUpgrade = async () => {
        if (!review) return;
        const result = await upgrade.mutateAsync({ reviewId: review.reviewId }).catch(() => null);
        // Refused before anything was written; the toast has said why, and the review is spent.
        if (!result) {
            setReview(null);
            return;
        }
        if (result.status === 'failed') {
            setFailed(result);
            return;
        }
        toast.success(`Release “${result.name}” upgraded`, {
            description: `${review.chart} ${review.version}, now revision ${result.revision}`,
        });
        navigateTo(releasePath(result.namespace, result.name));
    };

    if (review) {
        return page(
            <>
                <div className="flex items-center gap-2 pr-4.5">
                    {heading}
                    <div className="flex-1" />
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setReview(null)}>
                        <ArrowLeftIcon />
                        Back to values
                    </Button>
                    <Button
                        size="sm"
                        disabled={busy || upgradeProblem(review) !== null}
                        onClick={() => void runUpgrade()}
                    >
                        <CheckIcon />
                        {upgrade.isPending ? 'Upgrading…' : `Upgrade to revision ${review.revision}`}
                    </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto px-4.5 pb-4.5">
                    <UpgradeReview review={review} />
                </div>
            </>,
        );
    }

    const versionList = versions.data ?? [];
    const commitVersion = () => {
        if (versionDraft !== null && versionDraft.trim() !== '' && versionDraft.trim() !== version) {
            onPick({ ...pick, source, version: versionDraft.trim() });
        }
        setVersionDraft(null);
    };
    return page(
        <>
            <div className="flex flex-wrap items-end gap-3 pr-4.5">
                {heading}
                <div className="flex-1" />
                <div className="flex flex-col gap-1 pb-3">
                    <span className="text-meta text-text-muted">Source</span>
                    <Select
                        value={source ?? ''}
                        onValueChange={(next) => onPick({ chart: pick.chart, source: next })}
                        disabled={busy || sources.length === 0}
                    >
                        <SelectTrigger size="sm" className="w-40 font-mono" aria-label="Chart source">
                            <SelectValue placeholder="Finding…" />
                        </SelectTrigger>
                        <SelectContent>
                            {sources.map((one) => (
                                <SelectItem key={one.name} value={one.name} className="font-mono">
                                    {one.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex flex-col gap-1 pb-3">
                    <Label htmlFor={chartId} className="text-meta text-text-muted">
                        Chart
                    </Label>
                    <Input
                        id={chartId}
                        defaultValue={chart}
                        key={chart}
                        onBlur={(event) => {
                            const next = event.target.value.trim();
                            if (next !== '' && next !== chart) onPick({ source: pick.source, chart: next });
                        }}
                        className="h-8 w-44 font-mono"
                        spellCheck={false}
                        disabled={busy}
                    />
                </div>
                <div className="flex flex-col gap-1 pb-3">
                    {versions.data === null ? (
                        <>
                            <Label htmlFor={versionId} className="text-meta text-text-muted">
                                Version
                            </Label>
                            <Input
                                id={versionId}
                                value={versionDraft ?? version ?? ''}
                                onChange={(event) => setVersionDraft(event.target.value)}
                                onBlur={commitVersion}
                                onKeyDown={(event) => event.key === 'Enter' && commitVersion()}
                                className="h-8 w-36 font-mono"
                                spellCheck={false}
                                disabled={busy}
                            />
                        </>
                    ) : (
                        <>
                            <span className="text-meta text-text-muted">Version</span>
                            <Select
                                value={version ?? ''}
                                onValueChange={(next) => onPick({ ...pick, source, version: next })}
                                disabled={busy || versionList.length === 0}
                            >
                                <SelectTrigger size="sm" className="w-36 font-mono" aria-label="Chart version">
                                    <SelectValue placeholder="—" />
                                </SelectTrigger>
                                <SelectContent>
                                    {versionList.map((one) => (
                                        <SelectItem key={one} value={one} className="font-mono">
                                            {one}
                                            {one === release.data?.chartVersion && chart === release.data.chartName
                                                ? ' (current)'
                                                : ''}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </>
                    )}
                </div>
                <div className="pb-3">
                    <Button size="sm" disabled={!canReview} onClick={() => void runReview()}>
                        <EyeIcon />
                        {renderUpgrade.isPending ? 'Rendering…' : 'Review'}
                    </Button>
                </div>
            </div>
            <p className="px-4.5 pb-2 text-cell text-text-muted">
                The values start from revision {release.data?.revision ?? '…'}’s own and are the whole of what the new
                revision is given, over the chosen chart version’s defaults.
            </p>
            <div className="min-h-0 flex-1 px-4.5 pb-4.5">
                {versions.error ? (
                    <Notice title={describeError(versions.error).title} testId="upgrade-versions-error">
                        {describeError(versions.error).detail} Choose another source or chart.
                    </Notice>
                ) : values.error ? (
                    <Notice title={describeError(values.error).title} testId="upgrade-values-error">
                        {describeError(values.error).detail}
                    </Notice>
                ) : values.data ? (
                    <ChartValuesEditor
                        chart={values.data}
                        value={text}
                        onValueChange={setText}
                        renderError={renderError?.key === pickKey ? renderError.error : null}
                        className="h-full overflow-hidden rounded-card border border-border focus-within:border-ring"
                    />
                ) : (
                    <p className="p-4 text-cell text-text-muted">
                        {ready && version ? `Fetching ${chart} ${version}…` : 'Finding the chart…'}
                    </p>
                )}
            </div>
        </>,
    );
}
