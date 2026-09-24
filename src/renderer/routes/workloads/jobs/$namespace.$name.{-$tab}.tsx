import { createFileRoute } from '@tanstack/react-router';
import { PlayIcon } from 'lucide-react';
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
import { RetryJobButton } from '@/components/workload/job-actions';
import { ipcQueryKey } from '@/lib/query';
import { useResource } from '@/lib/resources';
import { JOB_TONE } from '@/lib/status';

export const Route = createFileRoute('/workloads/jobs/$namespace/$name/{-$tab}')({ component: JobDetailPage });

function JobDetailPage() {
    const { namespace, name } = Route.useParams();
    const query = useResource('Job', name, namespace);
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      overviewTab([
                          ['Completions', row.completions],
                          ['Duration', row.duration],
                          ['Status', row.status],
                          ['Age', row.age],
                      ]),
                      podsTab({ kind: 'Job', name, namespace }),
                      workloadLogsTab({ kind: 'Job', name, namespace }),
                      eventsTab({ kind: 'Job', name, namespace }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'Job', name, namespace }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={PlayIcon}
            eyebrow="Job"
            title={name}
            kind="Job"
            namespace={namespace}
            backTo="/workloads/jobs"
            query={query}
            found={!!row}
            status={row ? { label: row.status, tone: JOB_TONE[row.status] } : undefined}
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('resources.get', { kind: 'Job', name, namespace })]} />
                    <EditResourceButton />
                    <RetryJobButton name={name} namespace={namespace} />
                    <DeleteResourceButton kind="Job" name={name} namespace={namespace} backTo="/workloads/jobs" />
                </>
            }
            meta={row ? [`completions: ${row.completions}`, `duration: ${row.duration}`] : undefined}
            groups={groups}
            testId="job-page"
        />
    );
}
