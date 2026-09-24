import { createFileRoute } from '@tanstack/react-router';
import { PencilIcon } from 'lucide-react';
import { RefreshButton } from '@/components/refresh-button';
import {
    eventsTab,
    labelsTab,
    overviewTab,
    ResourceDetail,
    type DetailTabGroup,
} from '@/components/templates/resource-detail';
import { manifestTab } from '@/components/templates/manifest-panel';
import { EditResourceButton } from '@/components/templates/edit-resource-button';
import { DeleteResourceButton } from '@/components/templates/delete-resource-button';
import { ipcQueryKey } from '@/lib/query';
import { useResource } from '@/lib/resources';
import { WEBHOOK_TONE } from '@/lib/status';

export const Route = createFileRoute('/addons/mutatingwebhooks_/$name/{-$tab}')({
    component: MutatingWebhookDetailPage,
});

function MutatingWebhookDetailPage() {
    const { name } = Route.useParams();
    const query = useResource('MutatingWebhookConfiguration', name);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Webhooks', String(row.webhooks)],
                          ['Names', row.webhookNames],
                          ['Failure policy', row.failurePolicy],
                          ['Age', row.age],
                      ]),
                      eventsTab({ kind: 'MutatingWebhookConfiguration', name }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'MutatingWebhookConfiguration', name }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={PencilIcon}
            eyebrow="MutatingWebhookConfiguration"
            title={name}
            kind="MutatingWebhookConfiguration"
            backTo="/addons/mutatingwebhooks"
            query={query}
            found={!!row}
            status={row ? { label: row.status, tone: WEBHOOK_TONE[row.status] } : undefined}
            actions={
                <>
                    <RefreshButton
                        queryKeys={[ipcQueryKey('resources.get', { kind: 'MutatingWebhookConfiguration', name })]}
                    />
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="MutatingWebhookConfiguration"
                        name={name}
                        backTo="/addons/mutatingwebhooks"
                    />
                </>
            }
            meta={row ? [`webhooks: ${row.webhooks}`, `failure: ${row.failurePolicy}`] : undefined}
            groups={groups}
            testId="mutatingwebhook-page"
        />
    );
}
