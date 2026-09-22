import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { PlugIcon } from 'lucide-react';
import type { ApiService } from '../../../../shared/k8s/apiserver';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, statusColumn, textColumn } from '@/components/templates/list-columns';
import { API_SERVICE_TONE } from '@/lib/status';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/addons/apiservices/')({ component: ApiServicesPage });

const detailPath = (service: Pick<ApiService, 'name'>) => `/addons/apiservices/${encodeURIComponent(service.name)}`;

const columns: ColumnDef<ApiService>[] = [
    nameColumn<ApiService>({ href: detailPath }),
    textColumn<ApiService>('service', 'Backing service', { size: 220, small: true }),
    statusColumn<ApiService, ApiService['status']>(API_SERVICE_TONE),
    textColumn<ApiService>('reason', 'Reason', { small: true, muted: true, truncate: true }),
    ageColumn<ApiService>(),
];

function ApiServicesPage() {
    const services = useWatchedList('APIService');
    return (
        <ResourceListPage
            clusterScoped
            icon={PlugIcon}
            title="API Services"
            columns={columns}
            query={services}
            detailPath={detailPath}
            rowProps={(service) => ({ 'data-apiservice': service.name })}
            selection={{ kind: 'APIService' }}
            testId="apiservices-table"
            footerNote={services.live ? 'live' : undefined}
        />
    );
}
