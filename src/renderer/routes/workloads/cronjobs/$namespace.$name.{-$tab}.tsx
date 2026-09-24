import { createFileRoute } from '@tanstack/react-router';
import { TimerIcon } from 'lucide-react';
import { RefreshButton } from '@/components/refresh-button';
import {
    eventsTab,
    labelsTab,
    overviewTab,
    ResourceDetail,
    type DetailTabGroup,
} from '@/components/templates/resource-detail';
import { podsTab } from '@/components/templates/owned-pods';
import { workloadLogsTab } from '@/components/workload/workload-logs-tab';
import { manifestTab } from '@/components/templates/manifest-panel';
import { EditResourceButton } from '@/components/templates/edit-resource-button';
import { DeleteResourceButton } from '@/components/templates/delete-resource-button';
import { SuspendCronJobButton, TriggerCronJobButton } from '@/components/workload/job-actions';
import { ipcQueryKey } from '@/lib/query';
import { useResource } from '@/lib/resources';

export const Route = createFileRoute('/workloads/cronjobs/$namespace/$name/{-$tab}')({ component: CronJobDetailPage });

function CronJobDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('CronJob', name, namespace);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Schedule', row.schedule],
                          ['Suspend', String(row.suspend)],
                          ['Active', String(row.active)],
                          ['Last schedule', row.lastSchedule],
                          ['Age', row.age],
                      ]),
                      podsTab({ kind: 'CronJob', name, namespace }),
                      workloadLogsTab({ kind: 'CronJob', name, namespace }),
                      eventsTab({ kind: 'CronJob', name, namespace }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'CronJob', name, namespace }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={TimerIcon}
            eyebrow="CronJob"
            title={name}
            kind="CronJob"
            namespace={namespace}
            backTo="/workloads/cronjobs"
            query={query}
            found={!!row}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'CronJob', name, namespace })]} />
                    <TriggerCronJobButton name={name} namespace={namespace} />
                    {row && <SuspendCronJobButton name={name} namespace={namespace} suspended={row.suspend} />}
                    <EditResourceButton />
                    <DeleteResourceButton
                        kind="CronJob"
                        name={name}
                        namespace={namespace}
                        backTo="/workloads/cronjobs"
                    />
                </>
            }
            meta={row ? [`schedule: ${row.schedule}`, `suspended: ${row.suspend}`] : undefined}
            groups={groups}
            testId="cronjob-page"
        />
    );
}
