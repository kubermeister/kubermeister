import { PassThrough, Writable } from 'node:stream';
import { Exec } from '@kubernetes/client-node';
import {
    execResizeSchema,
    streamSchemas,
    type StreamController,
    type StreamSend,
    type TerminalSize,
} from '../../shared/streams.js';
import { kubeConfig } from './client.js';
import { EXEC_CONTAINER_ROLES, reportMissingPod, resolvePodTarget } from './pod-target.js';

const DEFAULT_COMMAND = ['/bin/sh'];

/** A Writable that forwards every chunk to the renderer as raw terminal text. */
export function terminalSink(send: StreamSend): Writable {
    const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            send({ type: 'data', data: chunk.toString('utf8') });
            callback();
        },
    });
    sink.on('error', (error) => send({ type: 'error', message: error.message }));
    return sink;
}

/** The size a terminal opens at when the renderer has not measured one yet. */
const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

/**
 * A terminal sink the client can size the remote tty from: it reads `columns` and `rows` when the
 * session opens and again on every `resize` event, which is what it sends down the exec's resize
 * channel. Without them the client sends no size at all, and the shell keeps the default it was
 * started with whatever the panel does.
 */
export function resizableTerminalSink(
    send: StreamSend,
    size: TerminalSize,
): Writable & { columns: number; rows: number; resizeTo: (next: TerminalSize) => void } {
    const sink = Object.assign(terminalSink(send), {
        columns: size.cols,
        rows: size.rows,
        resizeTo(next: TerminalSize) {
            sink.columns = next.cols;
            sink.rows = next.rows;
            sink.emit('resize');
        },
    });
    return sink;
}

/**
 * Interactive exec into a container over a bidirectional stream: stdout and stderr flow to the
 * renderer as text, keystrokes come back through the controller's `write`. Stopping closes the
 * websocket.
 */
export async function startPodExecStream(rawInput: unknown, send: StreamSend): Promise<StreamController> {
    const input = streamSchemas['pods.exec'].parse(rawInput);
    const target = await resolvePodTarget(input.name, input.namespace, input.container, EXEC_CONTAINER_ROLES);
    if (!target) return reportMissingPod(send, input.name, input.namespace, input.container);

    const stdin = new PassThrough();
    const stdout = resizableTerminalSink(send, input.size ?? DEFAULT_SIZE);
    const socket = await new Exec(kubeConfig()).exec(
        target.namespace,
        target.name,
        target.container,
        input.command ?? DEFAULT_COMMAND,
        stdout,
        terminalSink(send),
        stdin,
        true,
        () => send({ type: 'end' }),
    );

    return {
        stop: () => {
            try {
                socket.close();
            } catch {
                // already closed
            }
        },
        write: (data) => {
            if (typeof data === 'string') {
                stdin.write(data);
                return;
            }
            const resize = execResizeSchema.safeParse(data);
            if (resize.success) stdout.resizeTo(resize.data.resize);
        },
    };
}
