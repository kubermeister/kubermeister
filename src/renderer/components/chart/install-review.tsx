import { ChevronRightIcon, TriangleAlertIcon } from 'lucide-react';
import { reviewProblem, type ChartReview, type ReviewedHook, type ReviewedObject } from '../../../shared/chart-install';
import { StatusBadge } from '@/components/data-display/status-badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DRY_RUN_LABEL, DRY_RUN_TONE } from '@/lib/status';

function isHook(object: ReviewedObject | ReviewedHook): object is ReviewedHook {
    return 'events' in object;
}

function ReviewedRow({ object }: { object: ReviewedObject | ReviewedHook }) {
    const { check } = object;
    return (
        <Collapsible asChild>
            <li
                className="border-b border-border last:border-b-0"
                data-object={`${object.kind}/${object.name}`}
                data-check={check.state}
            >
                <CollapsibleTrigger className="group flex w-full items-center gap-3 px-3.5 py-2 text-left hover:bg-muted/50">
                    <ChevronRightIcon className="size-3.5 shrink-0 text-text-muted transition-transform group-data-[state=open]:rotate-90" />
                    <span className="w-44 shrink-0 truncate font-mono text-meta text-text-muted">{object.kind}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-cell">
                        {object.name}
                        {object.namespace && <span className="text-text-muted"> · {object.namespace}</span>}
                    </span>
                    {isHook(object) && (
                        <span className="shrink-0 font-mono text-meta text-text-muted">
                            {object.events.join(', ')} · weight {object.weight}
                        </span>
                    )}
                    <StatusBadge tone={DRY_RUN_TONE[check.state]}>{DRY_RUN_LABEL[check.state]}</StatusBadge>
                </CollapsibleTrigger>
                {check.state !== 'passed' && (
                    <p
                        className={
                            check.state === 'failed'
                                ? 'px-3.5 pb-2 pl-10 text-cell text-danger'
                                : 'px-3.5 pb-2 pl-10 text-cell text-text-muted'
                        }
                    >
                        {check.message}
                    </p>
                )}
                <CollapsibleContent>
                    <div className="px-3.5 pb-3 pl-10">
                        <div className="pb-1 font-mono text-meta text-text-muted">{object.source}</div>
                        <pre className="max-h-96 overflow-auto rounded-md bg-code-bg p-3 font-mono text-meta leading-[1.6] text-text-2">
                            {object.manifest}
                        </pre>
                    </div>
                </CollapsibleContent>
            </li>
        </Collapsible>
    );
}

/** One kind of thing a review lists, each row with its check and its YAML one click away. */
export function ReviewSection({
    title,
    desc,
    items,
    testId,
}: {
    title: string;
    desc: string;
    items: (ReviewedObject | ReviewedHook)[];
    testId: string;
}) {
    if (items.length === 0) return null;
    return (
        <section className="rounded-card border border-border bg-card" data-testid={testId}>
            <header className="flex items-baseline gap-2 border-b border-border px-3.5 py-2.5">
                <h3 className="text-body font-semibold">{title}</h3>
                <span className="text-meta text-text-muted">{desc}</span>
            </header>
            <ul>
                {items.map((object) => (
                    <ReviewedRow key={`${object.kind}/${object.namespace ?? ''}/${object.name}`} object={object} />
                ))}
            </ul>
        </section>
    );
}

/**
 * Everything an install is about to write, in the order it writes it, each object with what the
 * server-side dry run said about it and its YAML one click away. Nothing has been written yet: this
 * is the render the install will write, not a preview of a second one.
 */
export function InstallReview({ review }: { review: ChartReview }) {
    const problem = reviewProblem(review);
    const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
    return (
        <div className="flex flex-col gap-3" data-testid="install-review">
            {review.usesLookup && (
                <div
                    className="flex gap-2 rounded-card border border-border bg-warn-bg px-3.5 py-2.5 text-cell text-warn"
                    data-testid="install-review-lookup"
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
                    data-testid="install-review-problem"
                >
                    {problem} Nothing has been written; change the values or the release name and review again.
                </p>
            )}
            <ReviewSection
                title="Custom resource definitions"
                desc={`${count(review.crds.length, 'definition')} from crds/, created first and never removed by an uninstall`}
                items={review.crds}
                testId="install-review-crds"
            />
            <ReviewSection
                title="Hooks"
                desc={`${count(review.hooks.length, 'hook')}; pre-install hooks run before the objects and post-install ones after, each waited on; the rest are only recorded`}
                items={review.hooks}
                testId="install-review-hooks"
            />
            <ReviewSection
                title="Objects"
                desc={`${count(review.objects.length, 'object')} in the order Helm installs them`}
                items={review.objects}
                testId="install-review-objects"
            />
        </div>
    );
}
