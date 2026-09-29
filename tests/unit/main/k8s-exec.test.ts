import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type { V1Status } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const exec = vi.fn();
vi.mock('@kubernetes/client-node', async () => ({
    ...(await vi.importActual<typeof import('@kubernetes/client-node')>('@kubernetes/client-node')),
    Exec: class {
        exec = exec;
    },
}));
const target = vi.fn();
vi.mock('../../../src/main/k8s/pod-target.js', async () => ({
    ...(await vi.importActual<typeof import('../../../src/main/k8s/pod-target.js')>(
        '../../../src/main/k8s/pod-target.js',
    )),
    resolvePodTarget: target,
}));
vi.mock('../../../src/main/k8s/client.js', () => ({ kubeConfig: () => ({}), apis: vi.fn(), readOrNull: vi.fn() }));

const { execFailure, startPodExecStream, terminalSink } = await import('../../../src/main/k8s/exec.js');

describe('startPodExecStream', () => {
    const socket = Object.assign(new EventEmitter(), { close: vi.fn() });
    let captured: {
        stdout: Writable;
        stderr: Writable;
        stdin: Readable;
        onStatus: (status: V1Status) => void;
        command: unknown;
    };

    beforeEach(() => {
        exec.mockReset();
        socket.removeAllListeners();
        socket.close.mockReset();
        target.mockReset();
        target.mockResolvedValue({ name: 'web-1', namespace: 'team-a', container: 'web' });
        exec.mockImplementation(async (_ns, _pod, _c, command, stdout, stderr, stdin, _tty, onStatus) => {
            captured = { stdout, stderr, stdin, onStatus, command };
            return socket;
        });
    });

    it('opens a tty shell by default, forwards output as text, and closes the socket on stop', async () => {
        const send = vi.fn();
        const ctl = await startPodExecStream({ name: 'web-1', namespace: 'team-a' }, send);
        expect(exec).toHaveBeenCalledWith(
            'team-a',
            'web-1',
            'web',
            ['/bin/sh'],
            expect.anything(),
            expect.anything(),
            expect.anything(),
            true,
            expect.any(Function),
        );
        captured.stdout.write(Buffer.from('$ '));
        captured.stderr.write(Buffer.from('warn\n'));
        expect(send.mock.calls.map((c) => c[0])).toEqual([
            { type: 'data', data: '$ ' },
            { type: 'data', data: 'warn\n' },
        ]);
        captured.onStatus({ status: 'Success' });
        expect(send).toHaveBeenLastCalledWith({ type: 'end' });
        ctl.stop();
        ctl.stop();
        expect(socket.close).toHaveBeenCalledTimes(2);
    });

    it('reports a failed command in its own words before ending', async () => {
        const send = vi.fn();
        await startPodExecStream({ name: 'web-1', namespace: 'team-a' }, send);
        const message = 'OCI runtime exec failed: exec: "/bin/sh": stat /bin/sh: no such file or directory';
        captured.onStatus({ status: 'Failure', reason: 'InternalError', message });
        socket.emit('close');
        expect(send.mock.calls.map((c) => c[0])).toEqual([{ type: 'error', message }, { type: 'end' }]);
    });

    it('ends the session when the socket closes without a status', async () => {
        const send = vi.fn();
        await startPodExecStream({ name: 'web-1', namespace: 'team-a' }, send);
        socket.emit('close');
        socket.emit('close');
        expect(send.mock.calls.map((c) => c[0])).toEqual([
            { type: 'error', message: 'The connection to the container was lost.' },
            { type: 'end' },
        ]);
    });

    it('ends only once when the status is followed by the close', async () => {
        const send = vi.fn();
        await startPodExecStream({ name: 'web-1', namespace: 'team-a' }, send);
        captured.onStatus({ status: 'Success' });
        socket.emit('close');
        expect(send.mock.calls.map((c) => c[0])).toEqual([{ type: 'end' }]);
    });

    it('sends nothing more once stopped', async () => {
        const send = vi.fn();
        const ctl = await startPodExecStream({ name: 'web-1', namespace: 'team-a' }, send);
        ctl.stop();
        socket.emit('close');
        expect(send).not.toHaveBeenCalled();
    });

    it('feeds string keystrokes to stdin and ignores anything else', async () => {
        const ctl = await startPodExecStream({ name: 'web-1', namespace: 'team-a', command: ['ls', '-la'] }, vi.fn());
        expect(captured.command).toEqual(['ls', '-la']);
        const chunks: string[] = [];
        captured.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
        ctl.write?.('ls\n');
        ctl.write?.({ not: 'a string' });
        await new Promise((resolve) => setImmediate(resolve));
        expect(chunks).toEqual(['ls\n']);
    });

    it('tells the pod the terminal size it opened with, and each size it is resized to', async () => {
        const ctl = await startPodExecStream(
            { name: 'web-1', namespace: 'team-a', size: { cols: 100, rows: 30 } },
            vi.fn(),
        );
        // The client sends a resize for a stdout that carries a size and says when it changes.
        const stdout = captured.stdout as Writable & { columns: number; rows: number };
        expect({ columns: stdout.columns, rows: stdout.rows }).toEqual({ columns: 100, rows: 30 });
        const resized = vi.fn();
        stdout.on('resize', resized);
        ctl.write?.({ resize: { cols: 132, rows: 40 } });
        expect({ columns: stdout.columns, rows: stdout.rows }).toEqual({ columns: 132, rows: 40 });
        expect(resized).toHaveBeenCalledOnce();
        // Nonsense is dropped rather than sent to the pod.
        ctl.write?.({ resize: { cols: 0, rows: -1 } });
        expect(resized).toHaveBeenCalledOnce();
    });

    it('opens at the size a terminal starts at when none was given', async () => {
        await startPodExecStream({ name: 'web-1', namespace: 'team-a' }, vi.fn());
        const stdout = captured.stdout as Writable & { columns: number; rows: number };
        expect({ columns: stdout.columns, rows: stdout.rows }).toEqual({ columns: 80, rows: 24 });
    });

    it('survives a socket that throws on close', async () => {
        socket.close.mockImplementation(() => {
            throw new Error('already closed');
        });
        const ctl = await startPodExecStream({ name: 'web-1', namespace: 'team-a' }, vi.fn());
        expect(() => ctl.stop()).not.toThrow();
    });

    it('only execs into a container that can still be running a process', async () => {
        await startPodExecStream({ name: 'web-1', namespace: 'team-a', container: 'migrate' }, vi.fn());
        expect(target).toHaveBeenCalledWith('web-1', 'team-a', 'migrate', ['app', 'ephemeral']);
    });

    it('reports a missing pod without opening a session', async () => {
        target.mockResolvedValue(null);
        const send = vi.fn();
        await startPodExecStream({ name: 'gone', namespace: 'team-a' }, send);
        expect(send).toHaveBeenNthCalledWith(1, { type: 'error', message: 'pod "team-a/gone" not found' });
        expect(exec).not.toHaveBeenCalled();
    });

    it('rejects invalid input', async () => {
        await expect(
            startPodExecStream({ name: 'web-1', namespace: 'team-a', command: [] }, vi.fn()),
        ).rejects.toThrow();
    });

    it('execFailure reads only a failure, falling back to its reason', () => {
        expect(execFailure({ status: 'Success' })).toBeNull();
        expect(execFailure({ status: 'Failure', reason: 'NonZeroExitCode' })).toBe('NonZeroExitCode');
        expect(execFailure({ status: 'Failure' })).toBe('the command failed');
    });

    it('terminalSink reports its own errors', () => {
        const send = vi.fn();
        const sink = terminalSink(send);
        sink.emit('error', new Error('closed'));
        expect(send).toHaveBeenCalledWith({ type: 'error', message: 'closed' });
    });
});

describe('terminalSink decoding', () => {
    it('keeps a character split across two frames whole', async () => {
        const send = vi.fn();
        const sink = terminalSink(send);
        const bytes = Buffer.from('héllo 世界 🙂', 'utf8');
        // Cut inside the four-byte emoji and inside the three-byte CJK character.
        const cuts = [2, 9, bytes.length - 2];
        let from = 0;
        for (const cut of [...cuts, bytes.length]) {
            sink.write(bytes.subarray(from, cut));
            from = cut;
        }
        sink.end();
        await new Promise((resolve) => setImmediate(resolve));
        const text = send.mock.calls.map((c) => (c[0] as { data: string }).data).join('');
        expect(text).toBe('héllo 世界 🙂');
        expect(text).not.toContain('�');
    });

    it('sends what is left of a character the stream ended inside of', async () => {
        const send = vi.fn();
        const sink = terminalSink(send);
        sink.write(Buffer.from('ok '));
        sink.write(Buffer.from('世', 'utf8').subarray(0, 2));
        sink.end();
        await new Promise((resolve) => setImmediate(resolve));
        expect(send.mock.calls.map((c) => c[0])).toEqual([
            { type: 'data', data: 'ok ' },
            { type: 'data', data: '�' },
        ]);
    });
});
