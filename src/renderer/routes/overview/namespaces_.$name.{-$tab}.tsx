import { createFileRoute } from '@tanstack/react-router';
import { BoxesIcon, GaugeIcon, LayersIcon } from 'lucide-react';
import { RefreshButton } from '@/components/refresh-button';
import {
    eventsTab,
    labelsTab,
    overviewTab,
    ResourceDetail,
    type DetailTab,
    type DetailTabGroup,
} from '@/components/templates/resource-detail';
import { manifestTab } from '@/components/templates/manifest-panel';
import { EditResourceButton } from '@/components/templates/edit-resource-button';
import { DeleteResourceButton } from '@/components/templates/delete-resource-button';
import { NavLink } from '@/components/layout/nav-link';
import { DetailCard, DetailMetrics } from '@/components/templates/detail-cards';
import { ipcQueryKey, useIpcQuery } from '@/lib/query';
import { useRefreshIntervalMs } from '@/lib/settings';
import { NAMESPACE_TONE } from '@/lib/status';
import type { NamespaceDetail } from '../../../shared/k8s/namespaces';

export const Route = createFileRoute('/overview/namespaces_/$name/{-$tab}')({ component: NamespaceDetailPage });

/** What lives in the namespace, each count a way into that kind's list rather than a number to read. */
function contentsTab(row: NamespaceDetail): DetailTab {
    return {
        id: 'contents',
        label: 'Contents',
        icon: LayersIcon,
        // DetailCard forwards no unknown props, so the test hook lives on the body it wraps.
        content: (
            <DetailCard title="Objects">
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-4" data-testid="namespace-counts">
                    {row.counts.map((count) => (
                        <NavLink
                            key={count.kind}
                            to={count.listPath}
                            className="flex items-baseline justify-between rounded px-2 py-1 hover:bg-elev-2"
                            data-count={count.kind}
                        >
                            <span className="text-body text-text-2">{count.kind}</span>
                            <span className="font-mono text-body text-primary tabular-nums">{count.count}</span>
                        </NavLink>
                    ))}
                </div>
            </DetailCard>
        ),
    };
}

/** The namespace's own budgets, which is what a quota screen filtered to one namespace would show. */
function budgetsTab(row: NamespaceDetail): DetailTab {
    return {
        id: 'budgets',
        label: 'Budgets',
        icon: GaugeIcon,
        content: (
            <>
                <DetailCard title="Quotas">
                    <div data-testid="namespace-quotas">
                        {row.quotas.length === 0 ? (
                            <p className="text-body text-text-muted">This namespace has no resource quota.</p>
                        ) : (
                            <div className="flex flex-col gap-1.5">
                                {row.quotas.map((quota) => (
                                    <div
                                        key={`${quota.name}/${quota.resource}`}
                                        className="flex items-baseline justify-between text-body"
                                        data-quota={quota.resource}
                                    >
                                        <span className="text-text-2">{quota.resource}</span>
                                        <span className="font-mono text-text-muted tabular-nums">
                                            {quota.used} / {quota.hard}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </DetailCard>
                <DetailCard title="Limits">
                    <div data-testid="namespace-limits">
                        {row.limits.length === 0 ? (
                            <p className="text-body text-text-muted">This namespace has no limit range.</p>
                        ) : (
                            <div className="flex flex-col gap-1.5">
                                {row.limits.map((limit) => (
                                    <div
                                        key={`${limit.name}/${limit.type}/${limit.resource}`}
                                        className="flex items-baseline justify-between text-body"
                                        data-limit={limit.resource}
                                    >
                                        <span className="text-text-2">
                                            {limit.type} {limit.resource}
                                        </span>
                                        <span className="font-mono text-text-muted tabular-nums">
                                            {limit.defaultRequest} → {limit.max}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </DetailCard>
            </>
        ),
    };
}

function NamespaceDetailPage() {
    const { name } = Route.useParams();
    const query = useIpcQuery('namespaces.detail', { name }, { refetchInterval: useRefreshIntervalMs() });
    const row = query.data;

    const groups: DetailTabGroup[] = row
        ? [
              {
                  label: 'OBSERVE',
                  items: [
                      {
                          id: 'overview',
                          label: 'Overview',
                          icon: BoxesIcon,
                          content: (
                              <>
                                  <DetailMetrics
                                      metrics={[
                                          {
                                              label: 'CPU',
                                              value: `${row.cpuUsed}m`,
                                              sub: `${row.cpuRequested}m requested`,
                                          },
                                          {
                                              label: 'Memory',
                                              value: `${row.memUsed}Mi`,
                                              sub: `${row.memRequested}Mi requested`,
                                          },
                                      ]}
                                  />
                                  {
                                      overviewTab([
                                          ['Phase', row.phase],
                                          ['Age', row.age],
                                      ]).content
                                  }
                              </>
                          ),
                      },
                      contentsTab(row),
                      budgetsTab(row),
                      eventsTab({ kind: 'Namespace', name }),
                  ],
              },
              {
                  label: 'INSPECT',
                  items: [
                      manifestTab({ kind: 'Namespace', name }),
                      labelsTab({ labels: row.labels, annotations: row.annotations }),
                  ],
              },
          ]
        : [];

    return (
        <ResourceDetail
            icon={BoxesIcon}
            eyebrow="Namespace"
            title={name}
            kind="Namespace"
            backTo="/overview/namespaces"
            query={query}
            found={!!row}
            status={
                row
                    ? { label: row.phase, tone: row.phase === 'Active' ? NAMESPACE_TONE.ok : NAMESPACE_TONE.warn }
                    : undefined
            }
            actions={
                <>
                    <RefreshButton queryKeys={[ipcQueryKey('namespaces.detail', { name })]} />
                    <EditResourceButton />
                    <DeleteResourceButton kind="Namespace" name={name} backTo="/overview/namespaces" />
                </>
            }
            meta={row ? [`phase: ${row.phase}`, `age: ${row.age}`] : undefined}
            groups={groups}
            testId="namespace-page"
        />
    );
}
