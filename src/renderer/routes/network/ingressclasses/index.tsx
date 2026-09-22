import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { LayersIcon } from 'lucide-react';
import type { IngressClass } from '../../../../shared/k8s/classes';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { Badge } from '@/components/ui/badge';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/network/ingressclasses/')({ component: IngressClassesPage });

const detailPath = (ingressClass: Pick<IngressClass, 'name'>) =>
    `/network/ingressclasses/${encodeURIComponent(ingressClass.name)}`;

const columns: ColumnDef<IngressClass>[] = [
    nameColumn<IngressClass>({ href: detailPath }),
    textColumn<IngressClass>('controller', 'Controller', { mono: true }),
    textColumn<IngressClass>('parameters', 'Parameters', { size: 220, small: true, muted: true }),
    {
        id: 'isDefault',
        header: 'Default',
        size: 90,
        accessorFn: (row) => row.isDefault,
        cell: ({ row }) =>
            row.original.isDefault ? (
                <Badge variant="accent" className="rounded-sm">
                    default
                </Badge>
            ) : (
                <span className="font-mono text-text-muted tabular-nums">—</span>
            ),
    },
    ageColumn<IngressClass>(),
];

function IngressClassesPage() {
    const classes = useWatchedList('IngressClass');
    return (
        <ResourceListPage
            clusterScoped
            icon={LayersIcon}
            title="Ingress Classes"
            columns={columns}
            query={classes}
            detailPath={detailPath}
            rowProps={(ingressClass) => ({ 'data-ingressclass': ingressClass.name })}
            selection={{ kind: 'IngressClass' }}
            testId="ingressclasses-table"
            footerNote={classes.live ? 'live' : undefined}
        />
    );
}
