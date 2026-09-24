import { createFileRoute } from '@tanstack/react-router';
import { CodeIcon, FileTextIcon, HistoryIcon, RocketIcon } from 'lucide-react';
import { StatusBadge } from '@/components/data-display/status-badge';
import { YamlEditor } from '@/components/data-display/yaml-editor';
import { ReleaseRollbackButton } from '@/components/release/release-rollback-button';
import { UninstallReleaseButton } from '@/components/release/uninstall-release-button';
import { DetailCard } from '@/components/templates/detail-cards';
import { ResourceDetail, type DetailTabGroup } from '@/components/templates/resource-detail';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useIpcQuery } from '@/lib/query';
import { useRefreshIntervalMs } from '@/lib/settings';
import { RELEASE_TONE } from '@/lib/status';

export const Route = createFileRoute('/addons/releases/$namespace/$name/{-$tab}')({ component: ReleaseDetailPage });

function ReleaseDetailPage() {
    const { namespace, name } = Route.useParams();
    const refetchInterval = useRefreshIntervalMs();
    const query = useIpcQuery('releases.get', { name, namespace }, { refetchInterval });
    const release = query.data;
    const revisions = useIpcQuery('releases.revisions', { name, namespace }, { refetchInterval }).data ?? [];

    // A release is decoded from Secrets rather than being an API object of its own, so it has no events.
    const groups: DetailTabGroup[] = [
        {
            label: 'OBSERVE',
            items: [
                {
                    id: 'revisions',
                    label: 'Revisions',
                    icon: HistoryIcon,
                    count: revisions.length || undefined,
                    content: (
                        <DetailCard
                            title="Revision history"
                            desc={`${revisions.length} ${revisions.length === 1 ? 'revision' : 'revisions'}`}
                        >
                            <Table data-testid="release-revisions">
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className="w-[60px]">Rev</TableHead>
                                        <TableHead className="w-[140px]">Status</TableHead>
                                        <TableHead className="w-[140px]">Chart version</TableHead>
                                        <TableHead className="w-[120px]">Updated</TableHead>
                                        <TableHead>Description</TableHead>
                                        <TableHead className="w-[110px]" />
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {revisions.map((revision) => (
                                        <TableRow key={revision.rev} data-revision={revision.rev}>
                                            <TableCell className="font-mono text-primary tabular-nums">
                                                #{revision.rev}
                                            </TableCell>
                                            <TableCell>
                                                <StatusBadge tone={RELEASE_TONE[revision.status]}>
                                                    {revision.status}
                                                </StatusBadge>
                                            </TableCell>
                                            <TableCell className="font-mono tabular-nums">
                                                {revision.chartVersion}
                                            </TableCell>
                                            <TableCell className="font-mono text-text-muted tabular-nums">
                                                {revision.updated}
                                            </TableCell>
                                            <TableCell className="text-text-2">{revision.description}</TableCell>
                                            <TableCell>
                                                {/* The running revision is the one there is no going back to. */}
                                                {release && Number(revision.rev) !== release.revision && (
                                                    <ReleaseRollbackButton
                                                        name={name}
                                                        namespace={namespace}
                                                        revision={Number(revision.rev)}
                                                        chart={revision.chartVersion}
                                                    />
                                                )}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </DetailCard>
                    ),
                },
                {
                    id: 'values',
                    label: 'Values',
                    icon: FileTextIcon,
                    content: (
                        <DetailCard title="Values" desc="User-supplied values (helm get values)">
                            <pre
                                className="overflow-auto rounded-md bg-code-bg p-4 font-mono text-meta leading-[1.65] text-text-2"
                                data-testid="release-values"
                            >
                                {release?.values ?? '# No user-supplied values — the release uses chart defaults.'}
                            </pre>
                        </DetailCard>
                    ),
                },
            ],
        },
        {
            label: 'INSPECT',
            items: [
                {
                    id: 'manifest',
                    label: 'Manifest',
                    icon: CodeIcon,
                    // The objects the revision rendered, as Helm stored them. It is history rather
                    // than a live read, so it is never editable: rolling back is what changes it.
                    fill: true,
                    content: (
                        <div className="flex min-h-0 flex-1 flex-col" data-testid="release-manifest">
                            <YamlEditor
                                value={release?.manifest ?? '# This revision rendered no objects of its own.\n'}
                                onValueChange={() => {}}
                                readOnly
                                aria-label="Rendered manifest"
                                className="min-h-0 flex-1"
                            />
                        </div>
                    ),
                },
            ],
        },
    ];

    return (
        <ResourceDetail
            icon={RocketIcon}
            eyebrow="Helm release"
            title={name}
            kind="Helm release"
            namespace={namespace}
            backTo="/addons/releases"
            query={query}
            found={!!release}
            status={release ? { label: release.status, tone: RELEASE_TONE[release.status] } : undefined}
            actions={<UninstallReleaseButton name={name} namespace={namespace} />}
            meta={
                release
                    ? [`chart: ${release.chart}`, `revision: ${release.revision}`, `namespace: ${release.namespace}`]
                    : undefined
            }
            groups={groups}
            testId="release-page"
        />
    );
}
