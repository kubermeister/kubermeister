import { StringDecoder } from 'node:string_decoder';
import { PassThrough, Writable } from 'node:stream';
import { Exec, type V1Status } from '@kubernetes/client-node';
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

/**
 * A Writable that forwards every chunk to the renderer as raw terminal text. One decoder per sink
 * holds the bytes of a character a websocket frame ended inside of until the next frame completes it.
 */
export function terminalSink(send: StreamSend): Writable {
    const decoder = new StringDecoder('utf8');
    const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            const data = decoder.write(chunk);
            if (data.length > 0) send({ type: 'data', data });
            callback();
        },
        final(callback) {
            const rest = decoder.end();
            if (rest.length > 0) send({ type: 'data', data: rest });
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

/** What a status that is not a success says went wrong, or `null` when the command succeeded. */
export function execFailure(status: V1Status): string | null {
    if (status.status !== 'Failure') return null;
    return status.message || status.reason || 'the command failed';
}

/**
 * Interactive exec into a container over a bidirectional stream: stdout and stderr flow to the
 * renderer as text, keystrokes come back through the controller's `write`. Stopping closes the
 * websocket.
 *
 * The session ends on whichever comes first: the status the API server sends when the command
 * exits, or the socket closing. The status only arrives when the server is still there to send it,
 * so a restarted API server, a dropped network or a proxy cutting an idle connection close the
 * socket without one, and a session that waited for the status would stay open forever.
 */
export async function startPodExecStream(rawInput: unknown, send: StreamSend): Promise<StreamController> {
    const input = streamSchemas['pods.exec'].parse(rawInput);
    const target = await resolvePodTarget(input.name, input.namespace, input.container, EXEC_CONTAINER_ROLES);
    if (!target) return reportMissingPod(send, input.name, input.namespace, input.container);

    const stdin = new PassThrough();
    const stdout = resizableTerminalSink(send, input.size ?? DEFAULT_SIZE);
    let ended = false;
    const end = (error: string | null) => {
        if (ended) return;
        ended = true;
        if (error) send({ type: 'error', message: error });
        send({ type: 'end' });
    };
    const socket = await new Exec(kubeConfig()).exec(
        target.namespace,
        target.name,
        target.container,
        input.command ?? DEFAULT_COMMAND,
        stdout,
        terminalSink(send),
        stdin,
        true,
        (status) => end(execFailure(status)),
    );
    socket.on('close', () => end('The connection to the container was lost.'));

    return {
        stop: () => {
            // Whoever stopped the stream has already let go of it; the close that follows is not news.
            ended = true;
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
