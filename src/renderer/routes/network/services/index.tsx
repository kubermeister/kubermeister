import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { GlobeIcon } from 'lucide-react';
import type { Service } from '../../../../shared/k8s/network';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { Badge } from '@/components/ui/badge';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/network/services/')({ component: ServicesPage });

const detailPath = (service: Pick<Service, 'namespace' | 'name'>) =>
    `/network/services/${encodeURIComponent(service.namespace)}/${encodeURIComponent(service.name)}`;

const columns: ColumnDef<Service>[] = [
    nameColumn<Service>({ href: detailPath }),
    {
        id: 'type',
        header: 'Type',
        size: 130,
        accessorFn: (row) => row.type,
        cell: ({ row }) => (
            <Badge variant={row.original.type === 'LoadBalancer' ? 'accent' : 'neutral'} className="rounded-sm">
                {row.original.type}
            </Badge>
        ),
    },
    textColumn<Service>('clusterIp', 'Cluster IP', { size: 140, mono: true, small: true, numeric: true }),
    textColumn<Service>('externalIp', 'External IP', {
        size: 140,
        mono: true,
        small: true,
        muted: true,
        numeric: true,
    }),
    textColumn<Service>('ports', 'Ports', { mono: true, small: true, numeric: true }),
    ageColumn<Service>(),
];

function ServicesPage() {
    const services = useWatchedList('Service');
    return (
        <ResourceListPage
            icon={GlobeIcon}
            title="Services"
            columns={columns}
            query={services}
            detailPath={detailPath}
            rowProps={(service) => ({ 'data-service': service.name })}
            selection={{ kind: 'Service' }}
            testId="services-table"
            footerNote={services.live ? 'live' : undefined}
        />
    );
}
