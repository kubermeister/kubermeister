import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { RocketIcon } from 'lucide-react';
import type { Release } from '../../../../shared/k8s/addons';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { nameColumn, statusColumn, textColumn } from '@/components/templates/list-columns';
import { useIpcQuery } from '@/lib/query';
import { useRefreshIntervalMs } from '@/lib/settings';
import { RELEASE_TONE } from '@/lib/status';

export const Route = createFileRoute('/helm/releases/')({ component: ReleasesPage });

const detailPath = (release: Pick<Release, 'namespace' | 'name'>) =>
    `/helm/releases/${encodeURIComponent(release.namespace)}/${encodeURIComponent(release.name)}`;

const columns: ColumnDef<Release>[] = [
    nameColumn<Release>({ href: detailPath }),
    textColumn<Release>('namespace', 'Namespace', { size: 160 }),
    textColumn<Release>('chart', 'Chart', { size: 240, mono: true }),
    textColumn<Release>('revision', 'Revision', { size: 100, mono: true, numeric: true }),
    statusColumn<Release, Release['status']>(RELEASE_TONE, { size: 130 }),
    textColumn<Release>('updated', 'Updated', { size: 140, mono: true, muted: true, numeric: true }),
];

function ReleasesPage() {
    const releases = useIpcQuery('releases.list', {}, { refetchInterval: useRefreshIntervalMs() });
    return (
        <ResourceListPage
            icon={RocketIcon}
            title="Releases"
            columns={columns}
            query={releases}
            detailPath={detailPath}
            rowProps={(release) => ({ 'data-release': release.name })}
            testId="releases-table"
        />
    );
}
