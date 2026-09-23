import { EventEmitter } from 'node:events';
import { PassThrough, type Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.fn();
vi.mock('@kubernetes/client-node', async () => ({
    ...(await vi.importActual<typeof import('@kubernetes/client-node')>('@kubernetes/client-node')),
    Log: class {
        log = log;
    },
}));
const target = vi.fn();
vi.mock('../../../src/main/k8s/pod-target.js', async () => ({
    ...(await vi.importActual<typeof import('../../../src/main/k8s/pod-target.js')>(
        '../../../src/main/k8s/pod-target.js',
    )),
    resolvePodTarget: target,
}));
const readNamespacedPodLog = vi.fn();
const apis = vi.fn(() => ({ core: { readNamespacedPodLog } }));
vi.mock('../../../src/main/k8s/client.js', () => ({ kubeConfig: () => ({}), apis, readOrNull: vi.fn() }));

const logs = await import('../../../src/main/k8s/logs.js');

describe('log line parsing', () => {
    it('splits the API timestamp from the message and leaves the message alone', () => {
        expect(logs.parseLogLine('2026-09-15T12:00:00.123Z GET /healthz 200')).toEqual({
            timestamp: '2026-09-15T12:00:00.123Z',
            message: 'GET /healthz 200',
        });
        expect(logs.parseLogLine('no-timestamp-here')).toEqual({
            timestamp: '',
            message: 'no-timestamp-here',
        });
        expect(logs.parseLogLine(' leading space')).toEqual({
            timestamp: '',
            message: ' leading space',
        });
        // A level the container printed is part of what it said, not a field of our own.
        expect(logs.parseLogLine('2026-09-15T12:00:00.123Z ERROR checkout gateway timeout')).toEqual({
            timestamp: '2026-09-15T12:00:00.123Z',
            message: 'ERROR checkout gateway timeout',
        });
    });

    it('reassembles lines split across chunks and flushes the tail', () => {
        const lines: string[] = [];
        const splitter = logs.createLineSplitter((line) => lines.push(line));
        splitter.push('alpha\nbe');
        splitter.push('ta\n\ngam');
        expect(lines).toEqual(['alpha', 'beta']);
        splitter.push('ma');
        expect(lines).toEqual(['alpha', 'beta']);
        splitter.flush();
        expect(lines).toEqual(['alpha', 'beta', 'gamma']);
        splitter.flush();
        expect(lines).toHaveLength(3);
    });
});

describe('startPodLogStream', () => {
    const controller = { abort: vi.fn() };
    let sink: Writable | undefined;
    // The client pipes the response body into the sink; the fake does the same so `pipe` fires.
    let source: PassThrough | undefined;

    beforeEach(() => {
        log.mockReset();
        controller.abort.mockReset();
        target.mockReset();
        target.mockResolvedValue({ name: 'web-1', namespace: 'team-a', container: 'web' });
        log.mockImplementation(async (_ns: string, _pod: string, _c: string, stream: Writable) => {
            sink = stream;
            source = new PassThrough();
            source.pipe(stream);
            return controller;
        });
    });

    it('follows the resolved container with the requested window and streams parsed lines', async () => {
        const send = vi.fn();
        const ctl = await logs.startPodLogStream(
            { name: 'web-1', namespace: 'team-a', tailLines: 50, sinceSeconds: 600 },
            send,
        );
        expect(log).toHaveBeenCalledWith('team-a', 'web-1', 'web', expect.anything(), {
            follow: true,
            tailLines: 50,
            sinceSeconds: 600,
            timestamps: true,
        });
        sink!.write(Buffer.from('2026-09-15T12:00:00Z hello\n2026-09-15T12:00:01Z ERR'));
        sink!.write(Buffer.from('OR boom\n'));
        expect(send.mock.calls.map((c) => c[0])).toEqual([
            { type: 'data', data: { timestamp: '2026-09-15T12:00:00Z', message: 'hello' } },
            { type: 'data', data: { timestamp: '2026-09-15T12:00:01Z', message: 'ERROR boom' } },
        ]);
        ctl.stop();
        expect(controller.abort).toHaveBeenCalledOnce();
    });

    it('defaults the tail to 500 lines and ends when the container output finishes', async () => {
        const send = vi.fn();
        await logs.startPodLogStream({ name: 'web-1', namespace: 'team-a' }, send);
        expect(log.mock.calls[0]![4]).toMatchObject({ tailLines: 500, sinceSeconds: undefined });
        sink!.write(Buffer.from('2026-09-15T12:00:02Z tail'));
        sink!.end();
        await new Promise((resolve) => setImmediate(resolve));
        expect(send).toHaveBeenCalledWith({
            type: 'data',
            data: { timestamp: '2026-09-15T12:00:02Z', message: 'tail' },
        });
        expect(send).toHaveBeenLastCalledWith({ type: 'end' });
    });

    it('treats the failure an abort raises on the body as the follow ending, not an error', async () => {
        const send = vi.fn();
        const ctl = await logs.startPodLogStream({ name: 'web-1', namespace: 'team-a' }, send);
        ctl.stop();
        expect(controller.abort).toHaveBeenCalledOnce();
        // Aborting the fetch fails the piped body; unheard, that is an uncaught exception.
        source!.destroy(new Error('This operation was aborted'));
        await new Promise((resolve) => setImmediate(resolve));
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });

    it('reports a body that fails mid-follow as an error followed by end', async () => {
        const send = vi.fn();
        await logs.startPodLogStream({ name: 'web-1', namespace: 'team-a' }, send);
        source!.destroy(new Error('connection reset'));
        await new Promise((resolve) => setImmediate(resolve));
        expect(send.mock.calls.map((c) => c[0])).toEqual([
            { type: 'error', message: 'connection reset' },
            { type: 'end' },
        ]);
    });

    it('reports a sink error instead of throwing', async () => {
        const send = vi.fn();
        await logs.startPodLogStream({ name: 'web-1', namespace: 'team-a' }, send);
        sink!.emit('error', new Error('broken pipe'));
        expect(send).toHaveBeenCalledWith({ type: 'error', message: 'broken pipe' });
    });

    it('reports a missing pod or container as an error followed by end without opening a log', async () => {
        target.mockResolvedValue(null);
        const send = vi.fn();
        const ctl = await logs.startPodLogStream({ name: 'gone', namespace: 'team-a', container: 'x' }, send);
        expect(send.mock.calls.map((c) => c[0])).toEqual([
            { type: 'error', message: 'container "x" of pod "team-a/gone" not found' },
            { type: 'end' },
        ]);
        expect(log).not.toHaveBeenCalled();
        expect(() => ctl.stop()).not.toThrow();
    });

    it('rejects invalid input before touching the cluster', async () => {
        await expect(
            logs.startPodLogStream({ name: 'web-1', namespace: 'team-a', tailLines: -1 }, vi.fn()),
        ).rejects.toThrow();
        await expect(logs.startPodLogStream({ name: 'web-1' }, vi.fn())).rejects.toThrow();
        expect(target).not.toHaveBeenCalled();
    });
});

describe('resolvePodTarget', () => {
    it('picks the requested container, else the first, and rejects unknown ones', async () => {
        const actual = await vi.importActual<typeof import('../../../src/main/k8s/pod-target.js')>(
            '../../../src/main/k8s/pod-target.js',
        );
        const client = await import('../../../src/main/k8s/client.js');
        const pod = { spec: { containers: [{ name: 'web' }, { name: 'sidecar' }] } };
        vi.mocked(client.readOrNull).mockResolvedValue(pod);
        vi.mocked(client.apis).mockReturnValue({ core: { readNamespacedPod: vi.fn() } } as never);
        await expect(actual.resolvePodTarget('web-1', 'team-a')).resolves.toEqual({
            name: 'web-1',
            namespace: 'team-a',
            container: 'web',
        });
        await expect(actual.resolvePodTarget('web-1', 'team-a', 'sidecar')).resolves.toMatchObject({
            container: 'sidecar',
        });
        await expect(actual.resolvePodTarget('web-1', 'team-a', 'nope')).resolves.toBeNull();
        vi.mocked(client.readOrNull).mockResolvedValue(undefined);
        await expect(actual.resolvePodTarget('gone', 'team-a')).resolves.toBeNull();
        vi.mocked(client.readOrNull).mockResolvedValue({ spec: { containers: [] } });
        await expect(actual.resolvePodTarget('empty', 'team-a')).resolves.toBeNull();
    });

    it('defaults to the first app container even when init containers come first in the spec', async () => {
        const actual = await vi.importActual<typeof import('../../../src/main/k8s/pod-target.js')>(
            '../../../src/main/k8s/pod-target.js',
        );
        const client = await import('../../../src/main/k8s/client.js');
        const pod = {
            spec: {
                initContainers: [{ name: 'migrate' }],
                containers: [{ name: 'web' }],
                ephemeralContainers: [{ name: 'debugger' }],
            },
        };
        vi.mocked(client.readOrNull).mockResolvedValue(pod);
        vi.mocked(client.apis).mockReturnValue({ core: { readNamespacedPod: vi.fn() } } as never);
        await expect(actual.resolvePodTarget('web-1', 'team-a')).resolves.toMatchObject({ container: 'web' });
    });

    it('reads logs from init and ephemeral containers, and execs only into ones that can still run', async () => {
        const actual = await vi.importActual<typeof import('../../../src/main/k8s/pod-target.js')>(
            '../../../src/main/k8s/pod-target.js',
        );
        const client = await import('../../../src/main/k8s/client.js');
        const pod = {
            spec: {
                initContainers: [{ name: 'migrate' }],
                containers: [{ name: 'web' }],
                ephemeralContainers: [{ name: 'debugger' }],
            },
        };
        vi.mocked(client.readOrNull).mockResolvedValue(pod);
        vi.mocked(client.apis).mockReturnValue({ core: { readNamespacedPod: vi.fn() } } as never);
        const { LOG_CONTAINER_ROLES, EXEC_CONTAINER_ROLES } = actual;
        await expect(actual.resolvePodTarget('web-1', 'team-a', 'migrate', LOG_CONTAINER_ROLES)).resolves.toMatchObject(
            {
                container: 'migrate',
            },
        );
        await expect(
            actual.resolvePodTarget('web-1', 'team-a', 'debugger', LOG_CONTAINER_ROLES),
        ).resolves.toMatchObject({ container: 'debugger' });
        await expect(actual.resolvePodTarget('web-1', 'team-a', 'migrate', EXEC_CONTAINER_ROLES)).resolves.toBeNull();
        await expect(
            actual.resolvePodTarget('web-1', 'team-a', 'debugger', EXEC_CONTAINER_ROLES),
        ).resolves.toMatchObject({ container: 'debugger' });
    });
});

// Keep EventEmitter referenced for the fake websocket shape used by sibling tests.
void EventEmitter;

describe('readPodLogSnapshot', () => {
    beforeEach(() => {
        target.mockReset();
        readNamespacedPodLog.mockReset();
        apis.mockImplementation(() => ({ core: { readNamespacedPodLog } }));
    });

    it('reads the resolved container with timestamps and parses every non-empty line', async () => {
        target.mockResolvedValue({ name: 'web-1', namespace: 'team-a', container: 'app' });
        readNamespacedPodLog.mockResolvedValue('2026-09-15T12:00:00Z started\n\n2026-09-15T12:00:01Z ERROR boom\n');
        const lines = await logs.readPodLogSnapshot({ name: 'web-1', namespace: 'team-a', sinceSeconds: 300 });
        expect(target).toHaveBeenCalledWith('web-1', 'team-a', undefined);
        expect(readNamespacedPodLog).toHaveBeenCalledWith({
            name: 'web-1',
            namespace: 'team-a',
            container: 'app',
            tailLines: 500,
            sinceSeconds: 300,
            previous: undefined,
            timestamps: true,
        });
        expect(lines).toEqual([
            { timestamp: '2026-09-15T12:00:00Z', message: 'started' },
            { timestamp: '2026-09-15T12:00:01Z', message: 'ERROR boom' },
        ]);
    });

    it('honours an explicit container and tail size', async () => {
        target.mockResolvedValue({ name: 'web-1', namespace: 'team-a', container: 'sidecar' });
        readNamespacedPodLog.mockResolvedValue('');
        await logs.readPodLogSnapshot({ name: 'web-1', namespace: 'team-a', container: 'sidecar', tailLines: 50 });
        expect(target).toHaveBeenCalledWith('web-1', 'team-a', 'sidecar');
        expect(readNamespacedPodLog).toHaveBeenCalledWith(
            expect.objectContaining({ container: 'sidecar', tailLines: 50 }),
        );
    });

    it('returns no lines for a missing pod and classifies API failures', async () => {
        target.mockResolvedValue(null);
        await expect(logs.readPodLogSnapshot({ name: 'gone', namespace: 'team-a' })).resolves.toEqual([]);
        expect(readNamespacedPodLog).not.toHaveBeenCalled();
        target.mockResolvedValue({ name: 'web-1', namespace: 'team-a', container: 'app' });
        readNamespacedPodLog.mockRejectedValue(new Error('boom'));
        await expect(logs.readPodLogSnapshot({ name: 'web-1', namespace: 'team-a' })).rejects.toMatchObject({
            op: 'pods.logSnapshot',
        });
    });
});

describe('a stream that has no pod to attach to', () => {
    it('reports what is missing, ends, and hands back a controller that does nothing', async () => {
        const { NOOP_CONTROLLER, reportMissingPod } = await import('../../../src/main/k8s/pod-target.js');
        const sent: unknown[] = [];
        const send = (message: unknown) => sent.push(message);

        const controller = reportMissingPod(send, 'web-1', 'team-a', 'sidecar');
        expect(sent[0]).toMatchObject({ type: 'error', message: expect.stringContaining('container "sidecar"') });
        expect(sent[1]).toEqual({ type: 'end' });
        expect(controller).toBe(NOOP_CONTROLLER);
        // Stopping a stream that never started is allowed, and does nothing.
        expect(() => controller.stop()).not.toThrow();

        sent.length = 0;
        reportMissingPod(send, 'web-1', 'team-a');
        expect(sent[0]).toMatchObject({ message: 'pod "team-a/web-1" not found' });
    });
});

describe('readPodLogText', () => {
    beforeEach(() => {
        target.mockReset();
        readNamespacedPodLog.mockReset();
        apis.mockImplementation(() => ({ core: { readNamespacedPodLog } }));
        target.mockResolvedValue({ name: 'web-1', namespace: 'team-a', container: 'app' });
    });

    it('reads the whole log rather than a tail, and says it was not cut', async () => {
        readNamespacedPodLog.mockResolvedValue('one\ntwo\n');
        await expect(logs.readPodLogText({ name: 'web-1', namespace: 'team-a' })).resolves.toEqual({
            text: 'one\ntwo\n',
            truncated: false,
        });
        // No tailLines: the file is meant to be the log, not the view.
        expect(readNamespacedPodLog.mock.calls[0][0]).not.toHaveProperty('tailLines');
    });

    it('keeps the newest bytes when the log is longer than the cap, cutting on a line boundary', async () => {
        const long = 'x'.repeat(logs.LOG_DOWNLOAD_BYTES) + '\nlast line\n';
        readNamespacedPodLog.mockResolvedValue(long);
        const result = await logs.readPodLogText({ name: 'web-1', namespace: 'team-a' });
        expect(result.truncated).toBe(true);
        expect(result.text.startsWith('x')).toBe(false);
        expect(result.text).toContain('last line');
    });

    it('reads the previous run when asked, and answers empty for a pod that is gone', async () => {
        readNamespacedPodLog.mockResolvedValue('');
        await logs.readPodLogText({ name: 'web-1', namespace: 'team-a', previous: true });
        expect(readNamespacedPodLog.mock.calls[0][0]).toMatchObject({ previous: true });

        target.mockResolvedValue(null);
        await expect(logs.readPodLogText({ name: 'ghost', namespace: 'team-a' })).resolves.toEqual({
            text: '',
            truncated: false,
        });
    });
});
