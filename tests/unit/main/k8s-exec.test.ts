import type { Readable, Writable } from 'node:stream';
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

const { startPodExecStream, terminalSink } = await import('../../../src/main/k8s/exec.js');

describe('startPodExecStream', () => {
    const socket = { close: vi.fn() };
    let captured: { stdout: Writable; stderr: Writable; stdin: Readable; onStatus: () => void; command: unknown };

    beforeEach(() => {
        exec.mockReset();
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
        captured.onStatus();
        expect(send).toHaveBeenLastCalledWith({ type: 'end' });
        ctl.stop();
        ctl.stop();
        expect(socket.close).toHaveBeenCalledTimes(2);
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

    it('terminalSink reports its own errors', () => {
        const send = vi.fn();
        const sink = terminalSink(send);
        sink.emit('error', new Error('closed'));
        expect(send).toHaveBeenCalledWith({ type: 'error', message: 'closed' });
    });
});
