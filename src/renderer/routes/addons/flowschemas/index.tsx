import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { WavesIcon } from 'lucide-react';
import type { FlowSchema } from '../../../../shared/k8s/apiserver';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, textColumn } from '@/components/templates/list-columns';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/addons/flowschemas/')({ component: FlowSchemasPage });

const detailPath = (schema: Pick<FlowSchema, 'name'>) => `/addons/flowschemas/${encodeURIComponent(schema.name)}`;

const columns: ColumnDef<FlowSchema>[] = [
    nameColumn<FlowSchema>({ href: detailPath }),
    textColumn<FlowSchema>('priorityLevel', 'Priority level', { size: 220 }),
    textColumn<FlowSchema>('matchingPrecedence', 'Precedence', { size: 120, mono: true, numeric: true }),
    textColumn<FlowSchema>('distinguisher', 'Distinguisher', { size: 160, muted: true }),
    ageColumn<FlowSchema>(),
];

function FlowSchemasPage() {
    const schemas = useWatchedList('FlowSchema');
    return (
        <ResourceListPage
            clusterScoped
            icon={WavesIcon}
            title="Flow Schemas"
            columns={columns}
            query={schemas}
            detailPath={detailPath}
            rowProps={(schema) => ({ 'data-flowschema': schema.name })}
            selection={{ kind: 'FlowSchema' }}
            testId="flowschemas-table"
            footerNote={schemas.live ? 'live' : undefined}
        />
    );
}
