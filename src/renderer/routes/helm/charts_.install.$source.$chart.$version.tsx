import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { InstallChart } from '@/components/chart/install-chart';

/**
 * Where installing one chart version starts. The source, the chart and the version are the path, so
 * the screens that offer an Install open it on the version they show, and switching the version here
 * replaces the path rather than adding a step Back has to walk through.
 */
export const Route = createFileRoute('/helm/charts_/install/$source/$chart/$version')({ component: InstallChartPage });

function InstallChartPage() {
    const { source, chart, version } = Route.useParams();
    const navigate = useNavigate();
    return (
        <InstallChart
            // A new chart is a new form; a new version of the same chart keeps what was typed.
            key={`${source}/${chart}`}
            source={source}
            chart={chart}
            version={version}
            onVersionChange={(next) =>
                void navigate({
                    to: '/helm/charts/install/$source/$chart/$version',
                    params: { source, chart, version: next },
                    replace: true,
                })
            }
        />
    );
}
