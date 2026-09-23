import { useDeferredValue, useState } from 'react';
import { toast } from 'sonner';
import type { PodDetail } from '../../../shared/k8s/pods';
import { LogViewer, SINCE_OPTIONS, type SinceOption } from '@/components/data-display/log-viewer';
import { downloadTextFile } from '@/lib/download';
import { invoke } from '@/lib/ipc';
import { isBrokenPattern, visibleLines, NO_SEARCH, type LogSearch } from '@/lib/log-filter';
import { useLogViewOptions } from '@/lib/log-view-options';
import { containerChoices } from '@/lib/pod-containers';
import { usePodLogStream } from '@/lib/pod-streams';
import { useLogBufferLines } from '@/lib/settings';
import { useIpcQuery } from '@/lib/query';

/** How much of the container's log to ask for until the reader picks a tail in the View menu. */
const TAIL_LINES = 500;

/** Pod logs tab: a live tail of the selected container, or a snapshot of it once Live is turned off. */
export function LogsTab({ name, namespace, pod }: { name: string; namespace: string; pod?: PodDetail | null }) {
    const choices = containerChoices(pod?.containers, ['app', 'init', 'ephemeral']);
    const containers = choices.map((c) => c.name);
    const containerRoles = new Map(choices.map((c) => [c.name, c.role]));
    const [selectedContainer, setSelectedContainer] = useState<string | null>(null);
    const [since, setSince] = useState<SinceOption>(SINCE_OPTIONS[0]!);
    // A log is opened to watch what the container is doing now, so the follow is already running;
    // turning Live off is how the reader holds the view still, and that is what the snapshot is for.
    const [live, setLive] = useState(true);
    const [search, setSearch] = useState<LogSearch>(NO_SEARCH);
    // Changing the tail changes the target, so the read is made again and the follow restarts on it.
    const tailLines = useLogViewOptions()[0].tail ?? TAIL_LINES;
    const container = selectedContainer && containers.includes(selectedContainer) ? selectedContainer : containers[0];

    const target = container ? { name, namespace, container, sinceSeconds: since.seconds, tailLines } : null;
    const snapshot = useIpcQuery('pods.logSnapshot', target ?? { name, namespace }, { enabled: !live && !!target });
    const stream = usePodLogStream(live ? target : null, useLogBufferLines());

    const source = live ? stream.lines : (snapshot.data ?? []);
    // Defer the search over the (up to 2,000-line) buffer so keystrokes stay responsive.
    const deferred = useDeferredValue(search);
    const lines = visibleLines(source, deferred);

    /**
     * The whole log from the API server, not the buffer on screen: what is downloaded is the
     * container's log, capped in main, rather than the tail this view happens to be showing.
     */
    const download = async () => {
        if (!container) return;
        const whole = await invoke('pods.logDownload', {
            name,
            namespace,
            container,
            sinceSeconds: since.seconds,
        }).catch(() => null);
        if (!whole) return;
        downloadTextFile(`${name}-${container}.log`, whole.text);
        if (whole.truncated) {
            toast.success('Log downloaded', { description: 'It was long, so the oldest lines were left behind.' });
        }
    };

    return (
        <LogViewer
            lines={lines}
            containers={containers}
            containerRoles={containerRoles}
            container={container}
            onContainerChange={setSelectedContainer}
            since={since}
            onSinceChange={setSince}
            live={live}
            onLiveToggle={() => setLive((v) => !v)}
            search={search}
            onSearchChange={setSearch}
            timestamps
            defaultTail={TAIL_LINES}
            onDownload={() => void download()}
            error={live ? stream.error : snapshot.error ? snapshot.error.message : null}
            filtered={lines.length !== source.length}
            brokenPattern={isBrokenPattern(search)}
        />
    );
}
