import { CopyIcon, DownloadIcon, ScrollTextIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { DescribeInput } from '../../../shared/k8s/describe';
import { describeToText } from '../../../shared/k8s/describe';
import { Button } from '@/components/ui/button';
import { DetailCard } from '@/components/templates/detail-cards';
import { ReadFailure } from '@/components/templates/read-failure';
import type { DetailTab } from '@/components/templates/resource-detail';
import { downloadTextFile } from '@/lib/download';
import { describeError } from '@/lib/k8s-error';
import { useIpcQuery } from '@/lib/query';

/**
 * The flat reading of an object, laid out as describe prints it. The same document is what gets
 * copied and downloaded, through the shared formatter, so what is on screen and what lands in the
 * clipboard cannot drift apart.
 */
export function DescribePanel({ kind, name, namespace }: DescribeInput) {
    const query = useIpcQuery('resources.describe', { kind, name, namespace });
    const document = query.data;

    if (query.isError) {
        return (
            <DetailCard title="Describe">
                <ReadFailure error={query.error} subject={{ one: kind }} onRetry={() => void query.refetch()} />
            </DetailCard>
        );
    }
    if (!document) {
        return (
            <DetailCard title="Describe" desc="Reading the object…">
                <div className="text-cell text-text-muted">Nothing to show yet.</div>
            </DetailCard>
        );
    }

    const text = describeToText(document);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
        } catch (error) {
            toast.error('Could not copy the description', { description: describeError(error).detail });
            return;
        }
        toast.success('Description copied');
    };

    return (
        <DetailCard
            title="Describe"
            desc={`${document.kind} ${document.namespace ? `${document.namespace}/` : ''}${document.name}`}
            action={
                <div className="flex gap-1">
                    <Button variant="ghost" size="xs" onClick={() => void copy()}>
                        <CopyIcon />
                        Copy
                    </Button>
                    <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => downloadTextFile(`${document.name}-describe.txt`, text)}
                    >
                        <DownloadIcon />
                        Download
                    </Button>
                </div>
            }
        >
            <div className="flex flex-col gap-5" data-testid="describe">
                {document.sections.map((section) => (
                    <section key={section.title} data-section={section.title}>
                        <h3 className="mb-1.5 text-label tracking-wide text-text-muted uppercase">{section.title}</h3>
                        <dl className="grid grid-cols-[minmax(7rem,14rem)_1fr] gap-x-4 gap-y-1 text-cell">
                            {section.rows.map((row, index) => (
                                <div key={`${row.label}-${index}`} className="contents">
                                    <dt className="text-text-muted">{row.label}</dt>
                                    <dd className="font-mono break-all text-text-2">{row.value}</dd>
                                </div>
                            ))}
                        </dl>
                        {section.blocks.map((block) => (
                            <div
                                key={block.title}
                                className="mt-3 border-l-2 border-border pl-3"
                                data-block={block.title}
                            >
                                <div className="mb-1 font-mono text-cell text-primary">{block.title}</div>
                                <dl className="grid grid-cols-[minmax(7rem,14rem)_1fr] gap-x-4 gap-y-1 text-cell">
                                    {block.rows.map((row) => (
                                        <div key={row.label} className="contents">
                                            <dt className="text-text-muted">{row.label}</dt>
                                            <dd className="font-mono break-all text-text-2">{row.value}</dd>
                                        </div>
                                    ))}
                                </dl>
                            </div>
                        ))}
                    </section>
                ))}
            </div>
        </DetailCard>
    );
}

/** Standard "Describe" tab, beside the manifest: the same object read two ways. */
export function describeTab(target: DescribeInput): DetailTab {
    return { id: 'describe', label: 'Describe', icon: ScrollTextIcon, content: <DescribePanel {...target} /> };
}
