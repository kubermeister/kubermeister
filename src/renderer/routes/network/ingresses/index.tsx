import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { RouteIcon } from 'lucide-react';
import type { Ingress } from '../../../../shared/k8s/network';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/network/ingresses/')({ component: IngressesPage });

const detailPath = (ingress: Pick<Ingress, 'namespace' | 'name'>) =>
    `/network/ingresses/${encodeURIComponent(ingress.namespace)}/${encodeURIComponent(ingress.name)}`;

const columns: ColumnDef<Ingress>[] = [
    nameColumn<Ingress>({ href: detailPath }),
    textColumn<Ingress>('className', 'Class', { size: 130 }),
    textColumn<Ingress>('hosts', 'Hosts', { size: 240, mono: true, small: true, truncate: true }),
    textColumn<Ingress>('address', 'Address', { size: 160, mono: true, small: true, muted: true, numeric: true }),
    textColumn<Ingress>('ports', 'Ports', { size: 90, mono: true, small: true, numeric: true }),
    ageColumn<Ingress>(),
];

function IngressesPage() {
    const ingresses = useWatchedList('Ingress');
    return (
        <ResourceListPage
            icon={RouteIcon}
            title="Ingresses"
            columns={columns}
            query={ingresses}
            detailPath={detailPath}
            rowProps={(ingress) => ({ 'data-ingress': ingress.name })}
            selection={{ kind: 'Ingress' }}
            testId="ingresses-table"
            footerNote={ingresses.live ? 'live' : undefined}
        />
    );
}
