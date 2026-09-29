import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from './helpers';
import { settingsFixture } from './settings-fixture';

const invoke = vi.fn();
const stream = vi.fn(() => ({ stop: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    stream,
    subscribe: vi.fn(() => () => {}),
}));

const toasts = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', async () => ({
    ...(await vi.importActual<typeof import('sonner')>('sonner')),
    toast: toasts,
}));

const download = { downloadTextFile: vi.fn() };
vi.mock('@/lib/download', () => download);

const { IpcError } = await import('@/lib/ipc');
const { relatedTab } = await import('@/components/templates/related-tab');
const { DescribePanel } = await import('@/components/templates/describe-panel');
const { RolloutStatusTab } = await import('@/components/deployment/rollout-status-tab');
const { OwnedPods } = await import('@/components/templates/owned-pods');
const { WorkloadLogs } = await import('@/components/workload/workload-logs-tab');
const { LogsTab } = await import('@/components/pod/logs-tab');

const timeout = new IpcError({ kind: 'timeout', detail: 'the read ceiling passed', op: 'read' });
const unreachable = new IpcError({ kind: 'unreachable', detail: 'connect ECONNREFUSED', op: 'read' });
const forbidden = new IpcError({ kind: 'forbidden', detail: 'pods is forbidden', op: 'read' });

/** Every read answers `failing` for `channel` and settings for the rest; nothing else is asked. */
function failOn(channel: string, error: unknown) {
    invoke.mockImplementation(async (asked: string) => {
        if (asked === 'settings.get') return settingsFixture();
        if (asked === channel) throw error;
        return new Promise(() => {});
    });
}

/** Every read stays pending, apart from settings. */
function neverAnswer() {
    invoke.mockImplementation(async (asked: string) =>
        asked === 'settings.get' ? settingsFixture() : new Promise(() => {}),
    );
}

beforeEach(() => {
    invoke.mockReset();
    stream.mockClear();
    toasts.success.mockReset();
    toasts.error.mockReset();
    download.downloadTextFile.mockReset();
});

describe('the Related tab', () => {
    const panel = () => relatedTab({ kind: 'Pod', name: 'web-1', namespace: 'team-a' }).content;

    it('says it is reading rather than that nothing names the object', async () => {
        neverAnswer();
        renderWithQuery(panel());
        expect(await screen.findByTestId('related-pending')).toBeInTheDocument();
        expect(screen.queryByTestId('related-empty')).toBeNull();
    });

    it('says why a failed read failed, and retries', async () => {
        failOn('resources.related', unreachable);
        renderWithQuery(panel());
        const failure = await screen.findByTestId('read-failure');
        expect(failure).toHaveTextContent('Cluster unreachable');
        expect(failure).toHaveTextContent('The cluster API server is unreachable.');
        expect(failure).toHaveTextContent('connect ECONNREFUSED');
        expect(screen.queryByTestId('related-empty')).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(invoke.mock.calls.filter(([c]) => c === 'resources.related')).toHaveLength(2));
    });
});

describe('the Describe panel', () => {
    it('says why a failed read failed instead of reading for good', async () => {
        failOn('resources.describe', forbidden);
        renderWithQuery(<DescribePanel kind="Pod" name="web-1" namespace="team-a" />);
        const failure = await screen.findByTestId('read-failure');
        expect(failure).toHaveTextContent('Access denied');
        expect(failure).toHaveTextContent("You don't have permission to view this Pod.");
        expect(screen.queryByText('Reading the object…')).toBeNull();
    });

    it('reports a clipboard that refuses the copy', async () => {
        invoke.mockImplementation(async (asked: string) =>
            asked === 'settings.get'
                ? settingsFixture()
                : { kind: 'Pod', name: 'web-1', namespace: 'team-a', sections: [] },
        );
        const writeText = vi.fn().mockRejectedValue(new Error('Document is not focused.'));
        Object.assign(navigator, { clipboard: { writeText } });
        renderWithQuery(<DescribePanel kind="Pod" name="web-1" namespace="team-a" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Copy' }));
        await waitFor(() =>
            expect(toasts.error).toHaveBeenCalledWith('Could not copy the description', {
                description: 'Document is not focused.',
            }),
        );
        expect(toasts.success).not.toHaveBeenCalled();
    });
});

describe('the Rollout tab', () => {
    it('says it is reading while the status is on its way', async () => {
        neverAnswer();
        renderWithQuery(<RolloutStatusTab name="web" namespace="team-a" />);
        expect(await screen.findByTestId('rollout-pending')).toBeInTheDocument();
    });

    it('says why a failed read failed instead of rendering nothing', async () => {
        failOn('deployments.rolloutStatus', forbidden);
        renderWithQuery(<RolloutStatusTab name="web" namespace="team-a" />);
        const failure = await screen.findByTestId('read-failure');
        expect(failure).toHaveTextContent("You don't have permission to view this Deployment.");
    });
});

describe('the Pods tab of a controller', () => {
    it('counts no pods while they are being read', async () => {
        neverAnswer();
        renderWithQuery(<OwnedPods kind="Deployment" name="web" namespace="team-a" />);
        expect(await screen.findByText('Reading the pods this Deployment owns…')).toBeInTheDocument();
        expect(screen.queryByText(/0 pods/)).toBeNull();
    });

    it('says why a failed read failed instead of claiming no pods', async () => {
        failOn('workloads.pods', forbidden);
        renderWithQuery(<OwnedPods kind="Deployment" name="web" namespace="team-a" />);
        const failure = await screen.findByTestId('read-failure');
        expect(failure).toHaveTextContent("You don't have permission to view Pods.");
        expect(screen.queryByText(/0 pods/)).toBeNull();
        expect(screen.queryByTestId('owned-pods')).toBeNull();
    });
});

describe('the Logs tab of a controller', () => {
    it('shows why its pods could not be read', async () => {
        failOn('workloads.pods', forbidden);
        renderWithQuery(<WorkloadLogs kind="Deployment" name="web" namespace="team-a" />);
        expect(await screen.findByRole('alert')).toHaveTextContent('Access denied: pods is forbidden');
        expect(stream).not.toHaveBeenCalled();
    });
});

describe('the Logs tab of a pod', () => {
    it('reports a download that failed', async () => {
        failOn('pods.logDownload', timeout);
        const pod = { containers: [{ name: 'web', role: 'app' }] } as never;
        renderWithQuery(<LogsTab name="web-1" namespace="team-a" pod={pod} />);
        await userEvent.click(await screen.findByRole('button', { name: /download/i }));
        await waitFor(() =>
            expect(toasts.error).toHaveBeenCalledWith('Cluster timed out', {
                description: 'the read ceiling passed',
            }),
        );
        expect(download.downloadTextFile).not.toHaveBeenCalled();
    });
});
