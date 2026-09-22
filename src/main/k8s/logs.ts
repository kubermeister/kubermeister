import { Writable, type Readable } from 'node:stream';
import { Log } from '@kubernetes/client-node';
import type { LogLine, PodLogDownload, PodLogDownloadInput, PodLogSnapshotInput } from '../../shared/k8s/logs.js';
import { streamSchemas, type StreamController, type StreamSend } from '../../shared/streams.js';
import { apis, kubeConfig } from './client.js';
import { withK8s } from './errors.js';
import { reportMissingPod, resolvePodTarget } from './pod-target.js';

const DEFAULT_TAIL_LINES = 500;

/**
 * With `timestamps: true` each line is `<RFC3339> <message>`; a line without a space is all
 * message. The message travels untouched: what the container printed is what the console shows.
 */
export function parseLogLine(line: string): LogLine {
    const space = line.indexOf(' ');
    const timestamp = space > 0 ? line.slice(0, space) : '';
    const message = space > 0 ? line.slice(space + 1) : line;
    return { timestamp, message };
}

/**
 * Split a chunked byte stream into complete lines. The trailing partial line is kept until the
 * next chunk completes it, so a line split across chunks arrives whole.
 */
export function createLineSplitter(onLine: (line: string) => void): {
    push: (chunk: string) => void;
    flush: () => void;
} {
    let buffer = '';
    return {
        push: (chunk) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) if (line.length > 0) onLine(line);
        },
        flush: () => {
            if (buffer.length > 0) onLine(buffer);
            buffer = '';
        },
    };
}

/** Follow a container's logs, pushing one parsed line per message until the container ends or the stream stops. */
export async function startPodLogStream(rawInput: unknown, send: StreamSend): Promise<StreamController> {
    const input = streamSchemas['pods.logs'].parse(rawInput);
    const target = await resolvePodTarget(input.name, input.namespace, input.container);
    if (!target) return reportMissingPod(send, input.name, input.namespace, input.container);

    const splitter = createLineSplitter((line) => send({ type: 'data', data: parseLogLine(line) }));
    const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            splitter.push(chunk.toString('utf8'));
            callback();
        },
    });
    sink.on('finish', () => {
        splitter.flush();
        send({ type: 'end' });
    });
    // A Writable that errors with no listener throws at the process level; report it instead.
    sink.on('error', (error) => send({ type: 'error', message: error.message }));

    // The client pipes the response body into the sink and keeps that source to itself. `pipe`
    // hands it over, and it needs an error listener: aborting the follow fails the source, and an
    // unheard failure is an uncaught exception in the main process, which stalls quitting behind
    // Electron's error dialog. An abort we asked for is the stream ending as intended.
    let stopped = false;
    let source: Readable | undefined;
    sink.on('pipe', (piped: Readable) => {
        source = piped;
        piped.on('error', (error) => {
            if (stopped) return;
            send({ type: 'error', message: error.message });
            send({ type: 'end' });
        });
    });

    const controller = await new Log(kubeConfig()).log(target.namespace, target.name, target.container, sink, {
        follow: true,
        tailLines: input.tailLines ?? DEFAULT_TAIL_LINES,
        sinceSeconds: input.sinceSeconds,
        previous: input.previous,
        timestamps: true,
    });
    return {
        stop: () => {
            stopped = true;
            controller.abort();
            source?.destroy();
        },
    };
}

/**
 * A one-shot read of a container's recent logs, the view shown before the user asks to follow.
 * A pod or container that does not exist yields no lines; the detail page already reports the pod.
 */
export function readPodLogSnapshot(input: PodLogSnapshotInput): Promise<LogLine[]> {
    return withK8s('pods.logSnapshot', async () => {
        const target = await resolvePodTarget(input.name, input.namespace, input.container);
        if (!target) return [];
        const raw = await apis().core.readNamespacedPodLog({
            name: target.name,
            namespace: target.namespace,
            container: target.container,
            tailLines: input.tailLines ?? DEFAULT_TAIL_LINES,
            sinceSeconds: input.sinceSeconds,
            previous: input.previous,
            timestamps: true,
        });
        return String(raw)
            .split('\n')
            .filter((line) => line.length > 0)
            .map(parseLogLine);
    });
}

/** Ceiling on a downloaded log: enough for a long incident, small enough to cross the bridge as one string. */
export const LOG_DOWNLOAD_BYTES = 8 * 1024 * 1024;

/**
 * A container's log as text, for saving. The API server is asked for the whole log rather than a
 * tail, and the cap is applied to what comes back: the newest bytes are kept, since a log read for
 * a file is read for what happened most recently.
 */
export function readPodLogText(input: PodLogDownloadInput): Promise<PodLogDownload> {
    return withK8s('pods.logDownload', async () => {
        const target = await resolvePodTarget(input.name, input.namespace, input.container);
        if (!target) return { text: '', truncated: false };
        const raw = String(
            await apis().core.readNamespacedPodLog({
                name: target.name,
                namespace: target.namespace,
                container: target.container,
                sinceSeconds: input.sinceSeconds,
                previous: input.previous,
                timestamps: true,
            }),
        );
        if (Buffer.byteLength(raw, 'utf8') <= LOG_DOWNLOAD_BYTES) return { text: raw, truncated: false };
        // Cut on a line boundary so the file never opens on half a line.
        const tail = Buffer.from(raw, 'utf8').subarray(-LOG_DOWNLOAD_BYTES).toString('utf8');
        return { text: tail.slice(tail.indexOf('\n') + 1), truncated: true };
    });
}
