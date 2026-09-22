import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { PencilIcon } from 'lucide-react';
import type { WebhookConfig } from '../../../../shared/k8s/admission';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, statusColumn, textColumn } from '@/components/templates/list-columns';
import { WEBHOOK_TONE } from '@/lib/status';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/addons/mutatingwebhooks/')({ component: MutatingWebhooksPage });

const detailPath = (configuration: Pick<WebhookConfig, 'name'>) =>
    `/addons/mutatingwebhooks/${encodeURIComponent(configuration.name)}`;

const columns: ColumnDef<WebhookConfig>[] = [
    nameColumn<WebhookConfig>({ href: detailPath }),
    textColumn<WebhookConfig>('webhooks', 'Webhooks', { size: 100, mono: true, numeric: true }),
    textColumn<WebhookConfig>('webhookNames', 'Names', { mono: true, small: true }),
    textColumn<WebhookConfig>('failurePolicy', 'Failure policy', { size: 140 }),
    statusColumn<WebhookConfig, WebhookConfig['status']>(WEBHOOK_TONE),
    ageColumn<WebhookConfig>(),
];

function MutatingWebhooksPage() {
    const configurations = useWatchedList('MutatingWebhookConfiguration');
    return (
        <ResourceListPage
            clusterScoped
            icon={PencilIcon}
            title="Mutating Webhooks"
            columns={columns}
            query={configurations}
            detailPath={detailPath}
            rowProps={(configuration) => ({ 'data-mutatingwebhook': configuration.name })}
            selection={{ kind: 'MutatingWebhookConfiguration' }}
            testId="mutatingwebhooks-table"
            footerNote={configurations.live ? 'live' : undefined}
        />
    );
}
