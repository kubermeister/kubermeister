import { PassThrough, Writable } from 'node:stream';
import { Exec } from '@kubernetes/client-node';
import { streamSchemas, type StreamController, type StreamSend } from '../../shared/streams.js';
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
    const socket = await new Exec(kubeConfig()).exec(
        target.namespace,
        target.name,
        target.container,
        input.command ?? DEFAULT_COMMAND,
        terminalSink(send),
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
            if (typeof data === 'string') stdin.write(data);
        },
    };
}
