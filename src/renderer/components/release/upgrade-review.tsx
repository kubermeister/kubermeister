import { ChevronRightIcon, TriangleAlertIcon } from 'lucide-react';
import {
    upgradeProblem,
    type ChartUpgradeReview,
    type RemovedObject,
    type UpgradedObject,
} from '../../../shared/chart-upgrade';
import { ReviewSection } from '@/components/chart/install-review';
import { DiffView } from '@/components/data-display/diff-view';
import { StatusBadge } from '@/components/data-display/status-badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DRY_RUN_LABEL, DRY_RUN_TONE, UPGRADE_CHANGE_LABEL, UPGRADE_CHANGE_TONE } from '@/lib/status';

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function Card({ title, desc, testId, children }: { title: string; desc: string; testId: string; children: React.ReactNode }) {
    return (
        <section className="rounded-card border border-border bg-card" data-testid={testId}>
            <header className="flex items-baseline gap-2 border-b border-border px-3.5 py-2.5">
                <h3 className="text-body font-semibold">{title}</h3>
                <span className="text-meta text-text-muted">{desc}</span>
            </header>
            {children}
        </section>
    );
}

function ObjectRow({ object }: { object: UpgradedObject }) {
    const { check } = object;
    return (
        <Collapsible asChild>
            <li
                className="border-b border-border last:border-b-0"
                data-object={`${object.kind}/${object.name}`}
                data-change={object.change}
                data-check={check.state}
            >
                <CollapsibleTrigger className="group flex w-full items-center gap-3 px-3.5 py-2 text-left hover:bg-muted/50">
                    <ChevronRightIcon className="size-3.5 shrink-0 text-text-muted transition-transform group-data-[state=open]:rotate-90" />
                    <span className="w-44 shrink-0 truncate font-mono text-meta text-text-muted">{object.kind}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-cell">
                        {object.name}
                        {object.namespace && <span className="text-text-muted"> · {object.namespace}</span>}
                    </span>
                    <StatusBadge tone={UPGRADE_CHANGE_TONE[object.change]}>
                        {UPGRADE_CHANGE_LABEL[object.change]}
                    </StatusBadge>
                    {check.state !== 'passed' && (
                        <StatusBadge tone={DRY_RUN_TONE[check.state]}>{DRY_RUN_LABEL[check.state]}</StatusBadge>
                    )}
                </CollapsibleTrigger>
                {check.state !== 'passed' && <p className="px-3.5 pb-2 pl-10 text-cell text-danger">{check.message}</p>}
                <CollapsibleContent>
                    <div className="px-3.5 pb-3 pl-10">
                        <div className="pb-1 font-mono text-meta text-text-muted">{object.source}</div>
                        <DiffView
                            left={object.live}
                            right={object.next}
                            empty="The cluster already holds this object as the new revision has it."
                        />
                    </div>
                </CollapsibleContent>
            </li>
        </Collapsible>
    );
}

function RemovedRow({ object }: { object: RemovedObject }) {
    return (
        <Collapsible asChild>
            <li
                className="border-b border-border last:border-b-0"
                data-object={`${object.kind}/${object.name}`}
                data-kept={object.kept}
            >
                <CollapsibleTrigger className="group flex w-full items-center gap-3 px-3.5 py-2 text-left hover:bg-muted/50">
                    <ChevronRightIcon className="size-3.5 shrink-0 text-text-muted transition-transform group-data-[state=open]:rotate-90" />
                    <span className="w-44 shrink-0 truncate font-mono text-meta text-text-muted">{object.kind}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-cell">
                        {object.name}
                        {object.namespace && <span className="text-text-muted"> · {object.namespace}</span>}
                    </span>
                    <StatusBadge tone={object.kept ? 'neutral' : 'danger'}>
                        {object.kept ? 'Kept' : object.live === null ? 'Already gone' : 'Deleted'}
                    </StatusBadge>
                </CollapsibleTrigger>
                {object.kept && (
                    <p className="px-3.5 pb-2 pl-10 text-cell text-text-muted">
                        The chart annotated it <span className="font-mono">helm.sh/resource-policy: keep</span>, so it
                        stays in the cluster and no longer belongs to the release.
                    </p>
                )}
                <CollapsibleContent>
                    <div className="px-3.5 pb-3 pl-10">
                        {object.live === null ? (
                            <p className="text-cell text-text-muted">The cluster no longer holds it.</p>
                        ) : (
                            <pre className="max-h-96 overflow-auto rounded-md bg-code-bg p-3 font-mono text-meta leading-[1.6] text-text-2">
                                {object.live}
                            </pre>
                        )}
                    </div>
                </CollapsibleContent>
            </li>
        </Collapsible>
    );
}

/**
 * Everything an upgrade is about to change, before any of it is written: the values against the
 * current revision's, every rendered object against the one the cluster holds, what the new revision
 * drops, and the hooks it runs. The object diffs are the dry run's answer to the very write the
 * upgrade sends, so a field the server fills in is not shown as a change and one the render drops is.
 */
export function UpgradeReview({ review }: { review: ChartUpgradeReview }) {
    const problem = upgradeProblem(review);
    const changed = review.objects.filter((one) => one.change !== 'unchanged').length;
    const deleted = review.removed.filter((one) => !one.kept && one.live !== null).length;
    const runs = review.hooks.filter((one) => one.events.some((event) => event === 'pre-upgrade' || event === 'post-upgrade'));
    return (
        <div className="flex flex-col gap-3" data-testid="upgrade-review">
            {review.usesLookup && (
                <div
                    className="flex gap-2 rounded-card border border-border bg-warn-bg px-3.5 py-2.5 text-cell text-warn"
                    data-testid="upgrade-review-lookup"
                >
                    <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                    <p>
                        This chart calls <span className="font-mono">lookup</span>, which finds nothing while a chart is
                        rendered for review, exactly as in <span className="font-mono">helm template</span>. Whatever it
                        would have read from the cluster is missing from these objects.
                    </p>
                </div>
            )}
            {problem && (
                <p
                    role="alert"
                    className="rounded-card border border-border bg-danger-bg px-3.5 py-2.5 text-cell text-danger"
                    data-testid="upgrade-review-problem"
                >
                    {problem} Nothing has been written; change the values or the chart version and review again.
                </p>
            )}
            <Card
                title="Values"
                desc={`revision ${review.from.revision}’s user-supplied values against the new ones`}
                testId="upgrade-review-values"
            >
                <div className="p-3.5">
                    <DiffView
                        left={review.previousValues}
                        right={review.values}
                        empty={`The same values as revision ${review.from.revision}.`}
                    />
                </div>
            </Card>
            <Card
                title="Objects"
                desc={`${count(changed, 'object')} created or changed of ${review.objects.length}, in the order Helm applies them`}
                testId="upgrade-review-objects"
            >
                <ul>
                    {review.objects.map((object) => (
                        <ObjectRow key={`${object.kind}/${object.namespace ?? ''}/${object.name}`} object={object} />
                    ))}
                </ul>
            </Card>
            {review.removed.length > 0 && (
                <Card
                    title="Removed"
                    desc={`${count(deleted, 'object')} revision ${review.from.revision} rendered and the new revision does not, deleted after the others are applied`}
                    testId="upgrade-review-removed"
                >
                    <ul>
                        {review.removed.map((object) => (
                            <RemovedRow key={`${object.kind}/${object.namespace ?? ''}/${object.name}`} object={object} />
                        ))}
                    </ul>
                </Card>
            )}
            <ReviewSection
                title="Hooks"
                desc={`${count(runs.length, 'hook')} run; pre-upgrade hooks before the objects and post-upgrade ones after, each waited on; the rest are only recorded`}
                items={review.hooks}
                testId="upgrade-review-hooks"
            />
            {review.skippedCrds > 0 && (
                <p className="text-cell text-text-muted" data-testid="upgrade-review-crds">
                    The chart’s {count(review.skippedCrds, 'custom resource definition')} in{' '}
                    <span className="font-mono">crds/</span> are left alone: Helm installs them only on install and never
                    upgrades them.
                </p>
            )}
        </div>
    );
}
