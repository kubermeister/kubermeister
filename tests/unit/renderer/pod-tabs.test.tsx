import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PodDetail as PodDetailModel } from '../../../src/shared/k8s/pods';
import { NO_SEARCH } from '@/lib/log-filter';
import { renderInRouter, renderWithQuery } from './helpers';

const invoke = vi.fn();
/** Every forward stream opened, so a test can push what main would send back. */
const forwardMessages: ((message: unknown) => void)[] = [];
const stream = vi.fn((_channel: string, _input: unknown, onMessage: (message: unknown) => void) => {
    forwardMessages.push(onMessage);
    return { stop: vi.fn(), send: vi.fn() };
});
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    stream,
}));
const streams = { usePodLogStream: vi.fn(), openPodExec: vi.fn() };
vi.mock('@/lib/pod-streams', async () => ({
    ...(await vi.importActual<typeof import('@/lib/pod-streams')>('@/lib/pod-streams')),
    ...streams,
}));
const download = vi.fn();
vi.mock('@/lib/download', () => ({ downloadTextFile: download }));

// xterm needs a real layout engine and matchMedia; the shell tab is tested through this boundary.
const terminal = {
    open: vi.fn(),
    write: vi.fn(),
    dispose: vi.fn(),
    loadAddon: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    options: {} as Record<string, unknown>,
};
let terminalOptions: Record<string, unknown> | undefined;
vi.mock('@xterm/xterm', () => ({
    Terminal: class {
        constructor(options: Record<string, unknown>) {
            terminalOptions = options;
            return terminal;
        }
    },
}));
const fit = vi.fn();
vi.mock('@xterm/addon-fit', () => ({
    FitAddon: class {
        fit = fit;
    },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const toasts = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', async () => ({
    ...(await vi.importActual<typeof import('sonner')>('sonner')),
    toast: toasts,
}));

// Imported here rather than at the top: a static import would pull in the bridge before the mock
// above has its variables, which fails at module-evaluation time.
const { forwardSnapshot, stopAllForwards } = await import('@/lib/port-forwards');
const { LogViewer, SINCE_OPTIONS } = await import('@/components/data-display/log-viewer');
const { LogsTab } = await import('@/components/pod/logs-tab');
const { resetLogViewOptions, setLogViewOptions } = await import('@/lib/log-view-options');
const { NetworkTab } = await import('@/components/pod/network-tab');
const { OverviewTab } = await import('@/components/pod/overview-tab');
const { declaredPorts, parseLocalPort, PortForwardControl } = await import('@/components/pod/port-forward-control');
const { ShellTab } = await import('@/components/pod/shell-tab');
const { DARK_ANSI, LIGHT_ANSI, readTerminalTheme } = await import('@/lib/terminal-look');

const container = (
    name: string,
    ports: string[] = [],
    overrides: Partial<PodDetailModel['containers'][number]> = {},
) => ({
    name,
    image: `${name}:1.0`,
    imageId: 'sha256:abc',
    pullPolicy: 'Always',
    role: 'app',
    cpuUsed: null,
    memUsed: null,
    cpuRequested: null,
    memRequested: null,
    state: 'Running' as const,
    started: '2h ago',
    restarts: 0,
    cpuRequest: '100m',
    cpuLimit: '500m',
    memRequest: '64Mi',
    memLimit: '128Mi',
    ports,
    probes: [],
    ...overrides,
});
const pod: PodDetailModel = {
    name: 'web-1',
    namespace: 'team-a',
    status: 'Running',
    ready: '2/2',
    restarts: 0,
    age: '1d',
    node: 'n1',
    cpu: 0,
    mem: 0,
    cpuLimit: 0,
    memLimit: 0,
    podIP: '10.0.0.1',
    hostIP: '10.0.0.2',
    qos: 'Burstable',
    dnsPolicy: 'ClusterFirst',
    serviceAccount: 'default',
    conditions: [
        { type: 'Ready', ok: true, time: '1h ago' },
        { type: 'PodScheduled', ok: false, time: '—' },
    ],
    containers: [
        container('web', ['8080/TCP', '8443/TCP'], { probes: [{ kind: 'Readiness', spec: 'httpGet /:8080 · 10s' }] }),
        container('sidecar', ['8080/TCP'], { state: 'CrashLoop', restarts: 7 }),
    ],
    labels: [['app', 'web']],
    annotations: [],
};
const line = (message: string) => ({
    timestamp: '2026-09-15T12:00:00Z',
    message,
});
const idle = { lines: [], live: false, error: null, ended: false };
/** What the mocked follow hands back: the tab opens live, so its lines come from here. */
const following = (...messages: ReturnType<typeof line>[]) => ({
    lines: messages,
    live: true,
    error: null,
    ended: false,
});
/** The tab reads settings for its buffer size, so every mock answers that channel too. */
const SETTINGS = {
    version: 1,
    session: { lastContext: null, lastNamespace: null, restoreOnLaunch: true },
    connection: { kubeconfigPath: null },
    data: { refreshIntervalSec: 12, logBufferLines: 2000 },
    updates: { mode: 'check' },
    window: { bounds: null },
};
/** Answer the log channels with `lines`, and every other channel with what it expects. */
const answering =
    (lines: unknown, extra: Record<string, unknown> = {}) =>
    async (channel: string) => {
        if (channel === 'settings.get') return SETTINGS;
        if (channel in extra) return extra[channel];
        return lines;
    };

beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    invoke.mockReset();
    stream.mockClear();
    forwardMessages.length = 0;
    toasts.success.mockReset();
    download.mockReset();
    streams.usePodLogStream.mockReset();
    streams.usePodLogStream.mockReturnValue(idle);
    localStorage.clear();
    // The view options are one store outside React; a test starts from nothing.
    resetLogViewOptions();
});

describe('LogViewer', () => {
    const noop = () => {};
    const props = {
        containers: ['web', 'sidecar'],
        container: 'web',
        onContainerChange: noop,
        since: SINCE_OPTIONS[0]!,
        onSinceChange: noop,
        live: false,
        onLiveToggle: noop,
        search: NO_SEARCH,
        onSearchChange: noop,
        timestamps: true,
        onDownload: noop,
    };
    it('renders numbered lines as the container wrote them and a snapshot footer', () => {
        renderWithQuery(<LogViewer {...props} lines={[line('ERROR boom'), line('fine')]} filtered />);
        const list = screen.getByRole('list', { name: 'Log lines' });
        const rows = within(list).getAllByRole('listitem');
        expect(rows).toHaveLength(2);
        // The whole row: its number, its timestamp and the line. A level the container printed is
        // part of the line and is rendered once, never repeated as a column of the app's own.
        expect(rows[0]!.textContent).toBe('12026-09-15T12:00:00ZERROR boom');
        expect(rows[1]!.textContent).toBe('22026-09-15T12:00:00Zfine');
        expect(screen.getByTestId('log-status')).toHaveTextContent('snapshot · 2 lines (filtered)');
        expect(screen.getByTestId('log-viewer')).toHaveAttribute('data-live', 'false');
    });

    it('shows the live state, a stream error, and fires the toggles', async () => {
        const onLiveToggle = vi.fn();
        const onDownload = vi.fn();
        const onContainerChange = vi.fn();
        const onSinceChange = vi.fn();
        renderWithQuery(
            <LogViewer
                {...props}
                lines={[]}
                live
                error="forbidden"
                onLiveToggle={onLiveToggle}
                onDownload={onDownload}
                onContainerChange={onContainerChange}
                onSinceChange={onSinceChange}
            />,
        );
        expect(screen.getByTestId('log-viewer')).toHaveAttribute('data-live', 'true');
        expect(screen.getByRole('alert')).toHaveTextContent('forbidden');
        expect(screen.getByTestId('log-status')).toHaveTextContent('streaming · 0 lines');
        expect(screen.getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'true');
        await userEvent.click(screen.getByRole('button', { name: 'Live' }));
        expect(onLiveToggle).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole('button', { name: 'Download logs' }));
        expect(onDownload).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole('button', { name: 'Container' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'sidecar' }));
        expect(onContainerChange).toHaveBeenCalledWith('sidecar');
        await userEvent.click(screen.getByRole('button', { name: 'Since' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: '1 hour' }));
        expect(onSinceChange).toHaveBeenCalledWith({ label: '1 hour', seconds: 3600 });
    });

    it('offers highlighting beside the other two search toggles', async () => {
        const onSearchChange = vi.fn();
        renderWithQuery(<LogViewer {...props} lines={[]} onSearchChange={onSearchChange} />);
        const highlight = screen.getByRole('button', { name: 'Highlight matches' });
        expect(highlight).toHaveAttribute('aria-pressed', 'false');
        // It shows an icon and nothing else, so the name it carries is all a screen reader has.
        expect(highlight).toHaveTextContent('');
        expect(highlight.querySelector('svg')).toBeInTheDocument();
        await userEvent.click(highlight);
        expect(onSearchChange).toHaveBeenCalledWith({ ...NO_SEARCH, highlight: true });
    });
});

describe('LogsTab', () => {
    it('follows the first container from the moment it opens', async () => {
        invoke.mockImplementation(answering([line('from snapshot')]));
        streams.usePodLogStream.mockReturnValue(following(line('from stream')));
        renderWithQuery(<LogsTab name="web-1" namespace="team-a" pod={pod} />);
        expect(await screen.findByText('from stream')).toBeInTheDocument();
        expect(streams.usePodLogStream).toHaveBeenLastCalledWith(
            {
                name: 'web-1',
                namespace: 'team-a',
                container: 'web',
                sinceSeconds: 300,
                tailLines: 500,
            },
            // The buffer size comes from settings, so a live follow keeps what the user asked for.
            2000,
        );
        // Nothing is read one-shot while the stream is the source.
        expect(invoke).not.toHaveBeenCalledWith('pods.logSnapshot', expect.anything());
        expect(screen.getByTestId('log-viewer')).toHaveAttribute('data-live', 'true');
    });

    it('reads the tail the reader picked rather than the screen’s own', async () => {
        invoke.mockImplementation(answering([]));
        streams.usePodLogStream.mockReturnValue(following(line('from stream')));
        setLogViewOptions({ tail: 10000 });
        renderWithQuery(<LogsTab name="web-1" namespace="team-a" pod={pod} />);
        await screen.findByText('from stream');
        expect(streams.usePodLogStream).toHaveBeenLastCalledWith(expect.objectContaining({ tailLines: 10000 }), 2000);
    });

    it('holds the view still on a snapshot once Live is turned off', async () => {
        invoke.mockImplementation(answering([line('from snapshot')]));
        streams.usePodLogStream.mockReturnValue(following(line('from stream')));
        renderWithQuery(<LogsTab name="web-1" namespace="team-a" pod={pod} />);
        await screen.findByText('from stream');

        await userEvent.click(screen.getByRole('button', { name: 'Live' }));
        expect(await screen.findByText('from snapshot')).toBeInTheDocument();
        expect(invoke).toHaveBeenCalledWith('pods.logSnapshot', {
            name: 'web-1',
            namespace: 'team-a',
            container: 'web',
            sinceSeconds: 300,
            tailLines: 500,
        });
        // The follow is let go rather than left running behind a paused console.
        expect(streams.usePodLogStream).toHaveBeenLastCalledWith(null, 2000);
        expect(screen.queryByText('from stream')).not.toBeInTheDocument();
    });

    it('restarts the follow when the container or window changes and filters on the search', async () => {
        invoke.mockImplementation(answering([line('unused')]));
        streams.usePodLogStream.mockImplementation((input: { container: string; sinceSeconds?: number } | null) =>
            input ? following(line(`${input.container} since ${input.sinceSeconds ?? 'all'}`), line('noise')) : idle,
        );
        renderWithQuery(<LogsTab name="web-1" namespace="team-a" pod={pod} />);
        expect(await screen.findByText('web since 300')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Container' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'sidecar' }));
        expect(await screen.findByText('sidecar since 300')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Since' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'All logs' }));
        expect(await screen.findByText('sidecar since all')).toBeInTheDocument();
        await userEvent.type(screen.getByRole('textbox', { name: 'Filter log lines' }), 'NOISE');
        await waitFor(() => expect(screen.getByTestId('log-status')).toHaveTextContent('1 lines (filtered)'));
        expect(screen.queryByText('sidecar since all')).not.toBeInTheDocument();
    });

    it('downloads the whole log from the cluster rather than the buffer on screen', async () => {
        invoke.mockImplementation(
            answering([], { 'pods.logDownload': { text: 'every line ever\n', truncated: false } }),
        );
        streams.usePodLogStream.mockReturnValue(following(line('boom')));
        renderWithQuery(<LogsTab name="web-1" namespace="team-a" pod={pod} />);
        await screen.findByText('boom');
        await userEvent.click(screen.getByRole('button', { name: 'Download logs' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('pods.logDownload', {
                name: 'web-1',
                namespace: 'team-a',
                container: 'web',
                sinceSeconds: 300,
            }),
        );
        expect(download).toHaveBeenCalledWith('web-1-web.log', 'every line ever\n');
    });

    it('keeps only as many lines as the buffer setting allows, without restarting the follow', async () => {
        const { appendCapped } = await vi.importActual<typeof import('@/lib/pod-streams')>('@/lib/pod-streams');
        // The trimming itself: the newest lines survive, the oldest fall off the front.
        expect(appendCapped([line('one'), line('two')], [line('three')], 2).map((l) => l.message)).toEqual([
            'two',
            'three',
        ]);
        expect(appendCapped([line('one')], [line('two')], 5)).toHaveLength(2);
    });

    it('does nothing until the pod resolves to a container', () => {
        renderWithQuery(<LogsTab name="web-1" namespace="team-a" pod={null} />);
        expect(invoke).not.toHaveBeenCalledWith('pods.logSnapshot', expect.anything());
        expect(streams.usePodLogStream).toHaveBeenLastCalledWith(null, 2000);
        expect(screen.getByRole('button', { name: 'Container' })).toBeDisabled();
    });

    it('marks the matches and keeps the rest of the lines when asked to', async () => {
        invoke.mockImplementation(answering([]));
        streams.usePodLogStream.mockReturnValue(following(line('all good'), line('boom')));
        renderWithQuery(<LogsTab name="web-1" namespace="team-a" pod={pod} />);
        await screen.findByText('all good');

        await userEvent.click(screen.getByRole('button', { name: 'Highlight matches' }));
        await userEvent.type(screen.getByRole('textbox', { name: 'Filter log lines' }), 'boom');
        // Nothing is hidden, so the console never says it was narrowed.
        await waitFor(() => expect(screen.getByTestId('log-status')).toHaveTextContent('2 lines'));
        expect(screen.getByTestId('log-status')).not.toHaveTextContent('(filtered)');
        expect(screen.getByText('all good')).toBeInTheDocument();
        // The hit is still marked where it sits.
        expect(screen.getByRole('list', { name: 'Log lines' }).querySelector('mark')).toHaveTextContent('boom');
    });

    it('keeps the lines the search matched and brings the rest back when it is cleared', async () => {
        invoke.mockImplementation(answering([]));
        streams.usePodLogStream.mockReturnValue(following(line('all good'), line('boom')));
        renderWithQuery(<LogsTab name="web-1" namespace="team-a" pod={pod} />);
        await screen.findByText('all good');

        await userEvent.type(screen.getByRole('textbox', { name: 'Filter log lines' }), 'boom');
        await waitFor(() => expect(screen.queryByText('all good')).not.toBeInTheDocument());
        expect(screen.getByRole('list', { name: 'Log lines' }).querySelectorAll('[role="listitem"]')).toHaveLength(1);
        await userEvent.clear(screen.getByRole('textbox', { name: 'Filter log lines' }));
        await screen.findByText('all good');
    });

    it('matches case only when asked, and says when a download was cut short', async () => {
        invoke.mockImplementation(answering([], { 'pods.logDownload': { text: 'tail only\n', truncated: true } }));
        streams.usePodLogStream.mockReturnValue(following(line('Boom'), line('boom')));
        renderWithQuery(<LogsTab name="web-1" namespace="team-a" pod={pod} />);
        await screen.findByText('Boom');
        await userEvent.type(screen.getByRole('textbox', { name: 'Filter log lines' }), 'boom');
        await waitFor(() => expect(screen.getByTestId('log-status')).toHaveTextContent('2 lines'));
        await userEvent.click(screen.getByRole('button', { name: 'Aa' }));
        await waitFor(() => expect(screen.getByTestId('log-status')).toHaveTextContent('1 lines (filtered)'));

        await userEvent.click(screen.getByRole('button', { name: 'Download logs' }));
        await waitFor(() =>
            expect(toasts.success).toHaveBeenCalledWith('Log downloaded', {
                description: 'It was long, so the oldest lines were left behind.',
            }),
        );
    });

    it('says a pattern is not valid yet rather than emptying the console', async () => {
        invoke.mockImplementation(answering([]));
        streams.usePodLogStream.mockReturnValue(following(line('connection refused')));
        renderWithQuery(<LogsTab name="web-1" namespace="team-a" pod={pod} />);
        await screen.findByText('connection refused');
        await userEvent.click(screen.getByRole('button', { name: '.*' }));
        await userEvent.type(screen.getByRole('textbox', { name: 'Filter log lines' }), 'refused(');
        await waitFor(() => expect(screen.getByText('Not a valid pattern yet')).toBeInTheDocument());
        // The line is still there: an unfinished pattern filters nothing.
        expect(screen.getByText('connection refused')).toBeInTheDocument();
    });

    it('stamps every line with its time and keeps each one on a single row', async () => {
        invoke.mockImplementation(answering([]));
        streams.usePodLogStream.mockReturnValue(following(line('a very long line')));
        renderWithQuery(<LogsTab name="web-1" namespace="team-a" pod={pod} />);
        await screen.findByText('a very long line');
        expect(screen.getByText('2026-09-15T12:00:00Z')).toBeInTheDocument();
        expect(screen.getByRole('list', { name: 'Log lines' }).querySelector('[role="listitem"]')).toHaveClass(
            'whitespace-nowrap',
        );
    });
});

describe('OverviewTab', () => {
    it('renders metric placeholders, conditions, and every container with facts and probes', () => {
        renderWithQuery(<OverviewTab name="web-1" namespace="team-a" pod={pod} />);
        // "CPU" now names both the pod metric card and each container's usage row.
        expect(screen.getAllByText('CPU').length).toBeGreaterThan(0);
        expect(screen.getAllByText('no metrics yet')).toHaveLength(2);
        const conditions = screen.getByTestId('conditions');
        expect(conditions.querySelector('[data-condition="Ready"]')).toHaveAttribute('data-ok', 'true');
        expect(conditions.querySelector('[data-condition="PodScheduled"]')).toHaveTextContent('—');
        const containers = screen.getByTestId('containers');
        expect(containers).toHaveTextContent('2');
        const web = containers.querySelector('[data-container="web"]') as HTMLElement;
        expect(web).toHaveTextContent('web:1.0');
        expect(web).toHaveTextContent('Readiness');
        expect(within(web).getByText('Running')).toHaveAttribute('data-tone', 'ok');
        expect(web).toHaveTextContent('Pull policy Always');
        const sidecar = containers.querySelector('[data-container="sidecar"]') as HTMLElement;
        expect(within(sidecar).getByText('CrashLoop')).toHaveAttribute('data-tone', 'danger');
        expect(sidecar).toHaveTextContent('No probes configured.');
        expect(sidecar).toHaveClass('border-t');
        // No owner chain has arrived, so there is no workload to roll and Restart stays inert.
        expect(screen.getByRole('button', { name: 'Restart' })).toHaveAttribute('aria-disabled', 'true');
    });

    it('shows the workload above the pod, linking the kinds it can show', async () => {
        invoke.mockImplementation(async (channel: string) =>
            channel === 'pods.owners'
                ? [
                      { kind: 'ReplicaSet', name: 'web-abc', namespace: 'team-a', path: null },
                      {
                          kind: 'Deployment',
                          name: 'web',
                          namespace: 'team-a',
                          path: '/workloads/deployments/team-a/web',
                      },
                  ]
                : undefined,
        );
        renderInRouter(<OverviewTab name="web-1" namespace="team-a" pod={pod} />);
        const chain = await screen.findByTestId('owner-chain');
        expect(chain).toHaveTextContent('ReplicaSet');
        expect(chain).toHaveTextContent('web-abc');
        // The ReplicaSet has no screen, so it is named but not a link; the Deployment is.
        expect(within(chain).getAllByRole('link')).toHaveLength(1);
        expect(within(chain).getByRole('link', { name: 'web' })).toHaveAttribute(
            'href',
            expect.stringContaining('/workloads/deployments/team-a/web'),
        );
    });

    it('restarts the workload that owns the pod, since a pod alone cannot be restarted', async () => {
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'pods.owners') {
                return [
                    { kind: 'ReplicaSet', name: 'web-abc', namespace: 'team-a', path: null },
                    { kind: 'Deployment', name: 'web', namespace: 'team-a', path: '/workloads/deployments/team-a/web' },
                ];
            }
            if (channel === 'context.current') return { name: 'alpha', cluster: 'a', user: 'u', current: true };
            if (channel === 'resources.restart') return { kind: 'Deployment', name: 'web', namespace: 'team-a' };
            return undefined;
        });
        renderInRouter(<OverviewTab name="web-1" namespace="team-a" pod={pod} />);
        // The inert button is replaced by the real one once the chain names a workload to roll.
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Restart' })).not.toHaveAttribute('aria-disabled'),
        );
        await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('resources.restart', {
                context: 'alpha',
                kind: 'Deployment',
                name: 'web',
                namespace: 'team-a',
            }),
        );
    });

    it('shows each container’s usage against what it asked for', () => {
        const withUsage = {
            ...pod,
            containers: [
                {
                    ...pod.containers[0],
                    name: 'web',
                    role: 'app' as const,
                    cpuUsed: 60,
                    memUsed: 96,
                    cpuRequested: 200,
                    memRequested: 128,
                },
                { ...pod.containers[0], name: 'migrate', role: 'init' as const, cpuUsed: null, memUsed: null },
            ],
        };
        renderWithQuery(<OverviewTab name="web-1" namespace="team-a" pod={withUsage} />);
        const web = screen.getByTestId('containers').querySelector('[data-container="web"]') as HTMLElement;
        expect(within(web).getByText('60m of 200m')).toBeInTheDocument();
        expect(within(web).getByRole('progressbar', { name: 'CPU against request' })).toHaveAttribute(
            'aria-valuenow',
            '30',
        );
        // An init container is labelled as one, and shows a dash until metrics-server reports it.
        const migrate = screen.getByTestId('containers').querySelector('[data-container="migrate"]') as HTMLElement;
        expect(within(migrate).getByText('init')).toBeInTheDocument();
        expect(within(migrate).queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('shows the latest sampled usage with sparklines once series arrive', async () => {
        invoke.mockImplementation(async (channel: string) =>
            channel === 'metrics.podSeries' ? { cpu: [100, 250], mem: [60, 96] } : undefined,
        );
        renderWithQuery(<OverviewTab name="web-1" namespace="team-a" pod={pod} />);
        expect(await screen.findByText('250m')).toBeInTheDocument();
        expect(screen.getByText('96Mi')).toBeInTheDocument();
        expect(screen.getAllByText('current usage')).toHaveLength(2);
        expect(screen.getByText('250m').closest('[data-slot="card"]')?.querySelector('svg')).not.toBeNull();
        expect(invoke).toHaveBeenCalledWith('metrics.podSeries', { namespace: 'team-a', name: 'web-1' });
    });

    it('renders empty states before the pod resolves', () => {
        renderWithQuery(<OverviewTab name="web-1" namespace="team-a" pod={null} />);
        expect(screen.getByText('No conditions reported.')).toBeInTheDocument();
        expect(screen.getByTestId('containers')).toHaveTextContent('0');
    });
});

describe('ShellTab', () => {
    beforeEach(() => {
        for (const fn of [terminal.open, terminal.write, terminal.dispose, terminal.onData]) fn.mockClear();
        terminal.options = {};
        terminal.onData.mockReturnValue({ dispose: vi.fn() });
        invoke.mockResolvedValue({ version: 1, data: { terminalFontSize: 12 } });
    });

    it('opens one session into a themed terminal in the tab, and ends it when the tab goes', async () => {
        const session = { stop: vi.fn(), send: vi.fn() };
        streams.openPodExec.mockReturnValue(session);
        document.documentElement.classList.add('dark');
        const { unmount } = renderWithQuery(<ShellTab name="web-1" namespace="team-a" pod={pod} />);

        expect(streams.openPodExec).toHaveBeenCalledTimes(1);
        expect(streams.openPodExec).toHaveBeenCalledWith(
            { name: 'web-1', namespace: 'team-a', container: 'web' },
            expect.any(Object),
        );
        expect(terminal.open).toHaveBeenCalledWith(screen.getByTestId('terminal-host'));
        expect(terminalOptions?.theme).toMatchObject({ black: DARK_ANSI.black, background: '#0b0e14' });
        expect(screen.getByText('/bin/sh')).toBeInTheDocument();

        // The app flipping light or dark restyles the terminal without restarting the session.
        document.documentElement.classList.replace('dark', 'light');
        await waitFor(() => expect(terminal.options.theme).toMatchObject({ black: LIGHT_ANSI.black }));
        expect(streams.openPodExec).toHaveBeenCalledTimes(1);

        const callbacks = streams.openPodExec.mock.calls[0]![1] as {
            onData: (chunk: string) => void;
            onError: (message: string) => void;
            onEnd: () => void;
        };
        callbacks.onData('$ ');
        callbacks.onError('lost');
        callbacks.onEnd();
        expect(terminal.write).toHaveBeenNthCalledWith(1, '$ ');
        expect(terminal.write.mock.calls[1]![0]).toContain('lost');
        expect(terminal.write.mock.calls[2]![0]).toContain('session ended');
        const typed = terminal.onData.mock.calls.at(-1)![0] as (data: string) => void;
        typed('ls\n');
        expect(session.send).toHaveBeenCalledWith('ls\n');

        // Leaving the pod is how a shell is closed: nothing keeps it attached afterwards.
        unmount();
        expect(session.stop).toHaveBeenCalledOnce();
        expect(terminal.dispose).toHaveBeenCalledOnce();
        document.documentElement.classList.replace('light', 'dark');
    });

    it('waits for the pod before opening, then reopens against the container chosen', async () => {
        const session = { stop: vi.fn(), send: vi.fn() };
        streams.openPodExec.mockReturnValue(session);
        const { rerender } = renderWithQuery(<ShellTab name="web-1" namespace="team-a" pod={null} />);
        // Opening against a default container first would be a second session a moment later.
        expect(streams.openPodExec).not.toHaveBeenCalled();

        rerender(<ShellTab name="web-1" namespace="team-a" pod={pod} />);
        expect(streams.openPodExec).toHaveBeenCalledTimes(1);
        await userEvent.click(screen.getByRole('button', { name: 'Container' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'sidecar' }));
        expect(session.stop).toHaveBeenCalledOnce();
        expect(streams.openPodExec).toHaveBeenLastCalledWith(
            expect.objectContaining({ container: 'sidecar' }),
            expect.any(Object),
        );
    });

    it('reads token colours with fallbacks and the palette for the root class', () => {
        const host = document.createElement('div');
        expect(readTerminalTheme(host)).toMatchObject({ background: '#0b0e14', ...DARK_ANSI });
        document.documentElement.classList.add('light');
        expect(readTerminalTheme(host)).toMatchObject(LIGHT_ANSI);
        document.documentElement.classList.remove('light');
    });
});

describe('NetworkTab and PortForwardControl', () => {
    afterEach(() => stopAllForwards());

    it('lists connectivity facts with dashes for unknowns', () => {
        const { rerender } = renderWithQuery(<NetworkTab name="web-1" namespace="team-a" pod={pod} />);
        const network = screen.getByTestId('network');
        expect(network).toHaveTextContent('Ports & connectivity');
        expect(network).toHaveTextContent('10.0.0.1');
        expect(network).toHaveTextContent('8080/TCP, 8443/TCP, 8080/TCP');
        rerender(<NetworkTab name="web-1" namespace="team-a" pod={null} />);
        expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(7);
    });

    it('derives distinct declared ports and validates the local port', () => {
        expect(declaredPorts(pod)).toEqual([8080, 8443]);
        expect(declaredPorts(null)).toEqual([]);
        expect(parseLocalPort('', 8080)).toBe(8080);
        expect(parseLocalPort(' 9090 ', 8080)).toBe(9090);
        expect(parseLocalPort('0', 8080)).toBeNull();
        expect(parseLocalPort('70000', 8080)).toBeNull();
        expect(parseLocalPort('abc', 8080)).toBeNull();
    });

    it('starts with a chosen target and typed local port, shows status, and stops', async () => {
        renderWithQuery(<PortForwardControl name="web-1" namespace="team-a" pod={pod} />);
        await userEvent.click(screen.getByRole('button', { name: 'Target port' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: '8443' }));
        await userEvent.type(screen.getByRole('textbox', { name: 'Local port' }), '9090');
        await userEvent.click(screen.getByRole('button', { name: 'Start' }));
        expect(stream).toHaveBeenCalledWith(
            'pods.portForward',
            { kind: 'Pod', name: 'web-1', namespace: 'team-a', targetPort: 8443, localPort: 9090 },
            expect.any(Function),
        );

        // The forward now lives in the store, so the control reads its state from there.
        act(() =>
            forwardMessages[0]!({ type: 'data', data: { status: 'listening', localPort: 9090, targetPort: 8443 } }),
        );
        await waitFor(() =>
            expect(screen.getByTestId('port-forward-status')).toHaveTextContent('Listening on 127.0.0.1:9090 → 8443'),
        );
        expect(screen.getByRole('textbox', { name: 'Local port' })).toBeDisabled();
        await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
        await waitFor(() => expect(forwardSnapshot()).toEqual([]));
    });

    it('rejects an invalid local port, shows stream errors, and handles pods without ports', async () => {
        const { rerender } = renderWithQuery(<PortForwardControl name="web-1" namespace="team-a" pod={pod} />);
        await userEvent.type(screen.getByRole('textbox', { name: 'Local port' }), 'abc');
        await userEvent.click(screen.getByRole('button', { name: 'Start' }));
        expect(stream).not.toHaveBeenCalled();
        expect(screen.getByTestId('port-forward-status')).toHaveAttribute('data-error', 'true');
        expect(screen.getByTestId('port-forward-status')).toHaveTextContent(
            'error: enter a valid local port (1–65535)',
        );

        await userEvent.clear(screen.getByRole('textbox', { name: 'Local port' }));
        await userEvent.click(screen.getByRole('button', { name: 'Start' }));
        expect(stream).toHaveBeenCalledWith(
            'pods.portForward',
            expect.objectContaining({ localPort: 8080 }),
            expect.any(Function),
        );
        act(() => forwardMessages[0]!({ type: 'error', message: 'address in use' }));
        await waitFor(() =>
            expect(screen.getByTestId('port-forward-status')).toHaveTextContent('error: address in use'),
        );

        rerender(
            <PortForwardControl name="web-1" namespace="team-a" pod={{ ...pod, containers: [container('web')] }} />,
        );
        expect(screen.getByText('This pod declares no container ports.')).toBeInTheDocument();
    });

    it('forwards a service by its own ports, saying so when it exposes none', () => {
        const { rerender } = renderWithQuery(
            <PortForwardControl kind="Service" name="web" namespace="team-a" ports={[80]} />,
        );
        expect(screen.getByRole('button', { name: 'Target port' })).toHaveTextContent('80');
        rerender(<PortForwardControl kind="Service" name="web" namespace="team-a" ports={[]} />);
        expect(screen.getByText('This service exposes no ports.')).toBeInTheDocument();
    });
});
