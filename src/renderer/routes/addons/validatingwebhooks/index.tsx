import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { ShieldIcon } from 'lucide-react';
import type { WebhookConfig } from '../../../../shared/k8s/admission';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ageColumn, nameColumn, statusColumn, textColumn } from '@/components/templates/list-columns';
import { WEBHOOK_TONE } from '@/lib/status';
import { useWatchedList } from '@/lib/watch';

export const Route = createFileRoute('/addons/validatingwebhooks/')({ component: ValidatingWebhooksPage });

const detailPath = (configuration: Pick<WebhookConfig, 'name'>) =>
    `/addons/validatingwebhooks/${encodeURIComponent(configuration.name)}`;

const columns: ColumnDef<WebhookConfig>[] = [
    nameColumn<WebhookConfig>({ href: detailPath }),
    textColumn<WebhookConfig>('webhooks', 'Webhooks', { size: 100, mono: true, numeric: true }),
    textColumn<WebhookConfig>('webhookNames', 'Names', { mono: true, small: true }),
    textColumn<WebhookConfig>('failurePolicy', 'Failure policy', { size: 140 }),
    statusColumn<WebhookConfig, WebhookConfig['status']>(WEBHOOK_TONE),
    ageColumn<WebhookConfig>(),
];

function ValidatingWebhooksPage() {
    const configurations = useWatchedList('ValidatingWebhookConfiguration');
    return (
        <ResourceListPage
            clusterScoped
            icon={ShieldIcon}
            title="Validating Webhooks"
            columns={columns}
            query={configurations}
            detailPath={detailPath}
            rowProps={(configuration) => ({ 'data-validatingwebhook': configuration.name })}
            selection={{ kind: 'ValidatingWebhookConfiguration' }}
            testId="validatingwebhooks-table"
            footerNote={configurations.live ? 'live' : undefined}
        />
    );
}
