import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { PackageIcon } from 'lucide-react';
import type { HelmChart } from '../../../shared/k8s/addons';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { nameColumn, textColumn } from '@/components/templates/list-columns';
import { useIpcQuery } from '@/lib/query';
import { useRefreshIntervalMs } from '@/lib/settings';

export const Route = createFileRoute('/helm/charts')({ component: ChartsPage });

const columns: ColumnDef<HelmChart>[] = [
    nameColumn<HelmChart>(),
    textColumn<HelmChart>('repository', 'Repository', { size: 240 }),
    textColumn<HelmChart>('latestVersion', 'Latest version', { size: 130, mono: true, numeric: true }),
    textColumn<HelmChart>('appVersion', 'App version', { size: 120, mono: true, numeric: true }),
    textColumn<HelmChart>('description', 'Description', { muted: true, truncate: true }),
];

function ChartsPage() {
    const charts = useIpcQuery('helmCharts.list', {}, { refetchInterval: useRefreshIntervalMs() });
    return (
        <ResourceListPage
            icon={PackageIcon}
            title="Charts"
            columns={columns}
            query={charts}
            rowProps={(chart) => ({ 'data-chart': chart.name })}
            testId="charts-table"
        />
    );
}
