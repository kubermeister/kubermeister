import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { BoxesIcon } from 'lucide-react';
import type { Deployment } from '../../../../shared/k8s/workloads';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import {
    ageColumn,
    nameColumn,
    readyRatioColumn,
    scaleColumn,
    statusColumn,
    textColumn,
} from '@/components/templates/list-columns';
import { DEPLOYMENT_TONE } from '@/lib/status';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/workloads/deployments/')({ component: DeploymentsPage });

const detailPath = (d: Pick<Deployment, 'namespace' | 'name'>) =>
    `/workloads/deployments/${encodeURIComponent(d.namespace)}/${encodeURIComponent(d.name)}`;

const columns: ColumnDef<Deployment>[] = [
    nameColumn<Deployment>({ href: detailPath }),
    readyRatioColumn<Deployment>('ready'),
    scaleColumn<Deployment>('Deployment'),
    statusColumn<Deployment, Deployment['status']>(DEPLOYMENT_TONE, { size: 110 }),
    textColumn<Deployment>('updated', 'Updated', { size: 90, mono: true, numeric: true }),
    textColumn<Deployment>('available', 'Available', { size: 100, mono: true, numeric: true }),
    textColumn<Deployment>('strategy', 'Strategy', { size: 130 }),
    textColumn<Deployment>('image', 'Image', { mono: true, small: true, muted: true, truncate: true }),
    ageColumn<Deployment>(),
];

function DeploymentsPage() {
    const deployments = useWatchedList('Deployment');
    return (
        <ResourceListPage
            icon={BoxesIcon}
            title="Deployments"
            columns={columns}
            query={deployments}
            detailPath={detailPath}
            rowProps={(d) => ({ 'data-deployment': d.name })}
            selection={{ kind: 'Deployment' }}
            testId="deployments-table"
            footerNote={deployments.live ? 'live' : undefined}
        />
    );
}
