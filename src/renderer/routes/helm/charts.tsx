import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { DownloadIcon, PackageIcon } from 'lucide-react';
import type { AvailableChart, ChartRepositoryStatus } from '../../../shared/charts';
import { InstallChartDialog, installChartPath } from '@/components/chart/install-chart-dialog';
import { NavLink, useNavigateTo } from '@/components/layout/nav-link';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { nameColumn, textColumn } from '@/components/templates/list-columns';
import { Button } from '@/components/ui/button';
import { useChartRepositories } from '@/lib/chart-repositories';
import { useIpcQuery } from '@/lib/query';

export const Route = createFileRoute('/helm/charts')({ component: ChartsPage });

/**
 * What can be installed: every chart the configured classic repositories' cached indexes list, one
 * row per repository and chart. An OCI registry publishes no index, so its charts are not rows here;
 * they are installed by name from Settings › Charts or the palette.
 */
function ChartsPage() {
    const charts = useIpcQuery('charts.list', {});
    const repositories = useChartRepositories();
    const helm = useIpcQuery('helm.status', {});
    const navigateTo = useNavigateTo();
    // A chart asked for while no Helm was found: the dialog says Helm is required instead.
    const [blocked, setBlocked] = useState<AvailableChart | null>(null);

    const columns = useMemo<ColumnDef<AvailableChart>[]>(() => {
        const install = (chart: AvailableChart) => {
            if (helm.data?.found) navigateTo(installChartPath(chart.repository, chart.name, chart.latestVersion));
            else setBlocked(chart);
        };
        return [
            nameColumn<AvailableChart>(),
            textColumn<AvailableChart>('repository', 'Repository', { size: 200 }),
            textColumn<AvailableChart>('latestVersion', 'Latest version', { size: 130, mono: true, numeric: true }),
            textColumn<AvailableChart>('appVersion', 'App version', { size: 120, mono: true, numeric: true }),
            textColumn<AvailableChart>('description', 'Description', { muted: true, truncate: true }),
            {
                id: 'install',
                header: '',
                size: 96,
                enableHiding: false,
                enableSorting: false,
                cell: ({ row }) => (
                    <Button
                        variant="outline"
                        size="xs"
                        aria-label={`Install ${row.original.name}`}
                        onClick={() => install(row.original)}
                    >
                        <DownloadIcon />
                        Install
                    </Button>
                ),
            },
        ];
    }, [helm.data, navigateTo]);

    return (
        <>
            <ResourceListPage
                icon={PackageIcon}
                title="Charts"
                columns={columns}
                query={charts}
                rowProps={(chart) => ({ 'data-chart': `${chart.repository}/${chart.name}` })}
                emptyMessage={<ChartsEmpty repositories={repositories.data} />}
                clusterScoped
                testId="charts-table"
            />
            <InstallChartDialog
                open={blocked !== null}
                onOpenChange={(open) => !open && setBlocked(null)}
                repository={blocked?.repository}
                chart={blocked?.name}
            />
        </>
    );
}

/** Why there is nothing to list, which is always something to do under Settings › Charts. */
function ChartsEmpty({ repositories }: { repositories: ChartRepositoryStatus[] | undefined }) {
    const settings = (
        <NavLink to="/settings/charts" className="text-primary underline">
            Settings › Charts
        </NavLink>
    );
    const classic = repositories?.filter((one) => one.kind === 'classic') ?? [];
    return (
        <span data-testid="charts-empty">
            {repositories === undefined || repositories.length === 0 ? (
                <>No chart repository is configured. Add one under {settings} to list the charts it publishes.</>
            ) : classic.length === 0 ? (
                <>
                    OCI registries publish no list of their charts. Install one by name from {settings} or the command
                    palette.
                </>
            ) : (
                <>The configured repositories list no charts. Refresh them under {settings}.</>
            )}
        </span>
    );
}
