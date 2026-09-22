import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { WaypointsIcon } from 'lucide-react';
import type { Endpoints } from '../../../../shared/k8s/network';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/network/endpoints/')({ component: EndpointsPage });

const detailPath = (endpoints: Pick<Endpoints, 'namespace' | 'name'>) =>
    `/network/endpoints/${encodeURIComponent(endpoints.namespace)}/${encodeURIComponent(endpoints.name)}`;

const columns: ColumnDef<Endpoints>[] = [
    nameColumn<Endpoints>({ href: detailPath }),
    textColumn<Endpoints>('endpoints', 'Endpoints', { mono: true, small: true, numeric: true, truncate: true }),
    ageColumn<Endpoints>(),
];

function EndpointsPage() {
    const endpoints = useWatchedList('Endpoints');
    return (
        <ResourceListPage
            icon={WaypointsIcon}
            title="Endpoints"
            columns={columns}
            query={endpoints}
            detailPath={detailPath}
            rowProps={(row) => ({ 'data-endpoints': row.name })}
            selection={{ kind: 'Endpoints' }}
            testId="endpoints-table"
            footerNote={endpoints.live ? 'live' : undefined}
        />
    );
}
