import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { CpuIcon } from 'lucide-react';
import type { RuntimeClass } from '../../../../shared/k8s/classes';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/overview/runtimeclasses/')({ component: RuntimeClassesPage });

const detailPath = (runtimeClass: Pick<RuntimeClass, 'name'>) =>
    `/overview/runtimeclasses/${encodeURIComponent(runtimeClass.name)}`;

const columns: ColumnDef<RuntimeClass>[] = [
    nameColumn<RuntimeClass>({ href: detailPath }),
    textColumn<RuntimeClass>('handler', 'Handler', { size: 200, mono: true }),
    textColumn<RuntimeClass>('nodeSelector', 'Node selector', { mono: true, small: true }),
    textColumn<RuntimeClass>('overhead', 'Overhead', { size: 190, mono: true, small: true, muted: true }),
    ageColumn<RuntimeClass>(),
];

function RuntimeClassesPage() {
    const classes = useWatchedList('RuntimeClass');
    return (
        <ResourceListPage
            clusterScoped
            icon={CpuIcon}
            title="Runtime Classes"
            columns={columns}
            query={classes}
            detailPath={detailPath}
            rowProps={(runtimeClass) => ({ 'data-runtimeclass': runtimeClass.name })}
            selection={{ kind: 'RuntimeClass' }}
            testId="runtimeclasses-table"
            footerNote={classes.live ? 'live' : undefined}
        />
    );
}
