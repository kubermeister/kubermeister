import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { FileTextIcon } from 'lucide-react';
import type { ConfigMap } from '../../../../shared/k8s/workloads';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/workloads/configmaps/')({ component: ConfigMapsPage });

const detailPath = (configMap: Pick<ConfigMap, 'namespace' | 'name'>) =>
    `/workloads/configmaps/${encodeURIComponent(configMap.namespace)}/${encodeURIComponent(configMap.name)}`;

const columns: ColumnDef<ConfigMap>[] = [
    nameColumn<ConfigMap>({ icon: FileTextIcon, href: detailPath }),
    textColumn<ConfigMap>('keys', 'Keys', { size: 90, mono: true, numeric: true }),
    textColumn<ConfigMap>('size', 'Size', { size: 110, mono: true, muted: true, numeric: true }),
    ageColumn<ConfigMap>(),
];

function ConfigMapsPage() {
    const configMaps = useWatchedList('ConfigMap');
    return (
        <ResourceListPage
            icon={FileTextIcon}
            title="Config Maps"
            columns={columns}
            query={configMaps}
            detailPath={detailPath}
            rowProps={(configMap) => ({ 'data-configmap': configMap.name })}
            selection={{ kind: 'ConfigMap' }}
            testId="configmaps-table"
            footerNote={configMaps.live ? 'live' : undefined}
        />
    );
}
