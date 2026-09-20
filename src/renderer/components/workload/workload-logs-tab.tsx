import { useDeferredValue, useMemo, useState } from 'react';
import { ScrollTextIcon } from 'lucide-react';
import type { PodOwnerKind } from '../../../shared/k8s/owners';
import { LogViewer, SINCE_OPTIONS, type SinceOption } from '@/components/data-display/log-viewer';
import type { DetailTab } from '@/components/templates/resource-detail';
import { downloadTextFile } from '@/lib/download';
import { isBrokenPattern, visibleLines, NO_SEARCH, type LogSearch } from '@/lib/log-filter';
import { useLogViewOptions } from '@/lib/log-view-options';
import { podColors, useMultiPodLogStream } from '@/lib/multi-pod-logs';
import { useIpcQuery } from '@/lib/query';
import { useLogBufferLines, useRefreshIntervalMs } from '@/lib/settings';

/** Per pod, not in total: this view follows every pod of the workload at once. The reader's own
 * choice in the View menu is per pod for the same reason. */
const TAIL_LINES_PER_POD = 100;

interface WorkloadLogsProps {
    kind: PodOwnerKind;
    name: string;
    namespace: string;
}

/**
 * Every pod of one workload in a single view. There is no call for "the logs of this deployment",
 * so this follows each pod and merges what arrives, colouring by pod because interleaved streams
 * are unreadable otherwise. The set of pods is live: a rollout replaces them and the follow moves
 * with it rather than tailing pods that are already gone.
 */
export function WorkloadLogs({ kind, name, namespace }: WorkloadLogsProps) {
    const refetchInterval = useRefreshIntervalMs();
    const pods = useIpcQuery('workloads.pods', { kind, name, namespace }, { refetchInterval }).data;
    const names = useMemo(() => (pods ?? []).map((pod) => pod.name), [pods]);
    const colors = useMemo(() => podColors(names), [names]);

    const [since, setSince] = useState<SinceOption>(SINCE_OPTIONS[0]!);
    // Following from the moment the tab opens, like the pod's own Logs tab; one stream per pod.
    const [live, setLive] = useState(true);
    const [search, setSearch] = useState<LogSearch>(NO_SEARCH);
    const tailLines = useLogViewOptions()[0].tail ?? TAIL_LINES_PER_POD;

    const follow = useMultiPodLogStream(
        live ? names : [],
        live ? { namespace, sinceSeconds: since.seconds, tailLines } : null,
        useLogBufferLines(),
    );
    const deferred = useDeferredValue(search);
    const lines = visibleLines(follow.lines, deferred);
    const failures = Object.entries(follow.failures);

    const download = () =>
        downloadTextFile(
            `${name}-pods.log`,
            lines.map((line) => `${line.pod} ${line.timestamp} ${line.level} ${line.message}`).join('\n'),
        );

    return (
        <LogViewer
            lines={lines}
            podColors={colors}
            // Containers are per pod here, so the picker names the pods being followed instead.
            containers={names}
            container={names.length > 0 ? `${names.length} pods` : undefined}
            onContainerChange={() => {}}
            since={since}
            onSinceChange={setSince}
            live={live}
            onLiveToggle={() => setLive((v) => !v)}
            search={search}
            onSearchChange={setSearch}
            // Each line already names its pod, so the timestamp would crowd the row out.
            timestamps={false}
            defaultTail={TAIL_LINES_PER_POD}
            onDownload={download}
            error={failures.length > 0 ? `${failures[0]![0]}: ${failures[0]![1]}` : null}
            filtered={lines.length !== follow.lines.length}
            brokenPattern={isBrokenPattern(search)}
        />
    );
}

/** Standard "Logs" tab for a controller: every pod it owns, followed together. */
export function workloadLogsTab(target: WorkloadLogsProps): DetailTab {
    return {
        id: 'logs',
        label: 'Logs',
        icon: ScrollTextIcon,
        fill: true,
        keepMounted: true,
        content: <WorkloadLogs {...target} />,
    };
}
