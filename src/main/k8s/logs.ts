import { StringDecoder } from 'node:string_decoder';
import { Writable, type Readable } from 'node:stream';
import { ApiException, Log } from '@kubernetes/client-node';
import type { LogLine, PodLogDownload, PodLogDownloadInput, PodLogSnapshotInput } from '../../shared/k8s/logs.js';
import { streamSchemas, type StreamController, type StreamSend } from '../../shared/streams.js';
import { apis, kubeConfig } from './client.js';
import { K8sError, toK8sError, withK8s } from './errors.js';
import { reportMissingPod, resolvePodTarget, type PodTarget } from './pod-target.js';

const DEFAULT_TAIL_LINES = 500;
const FOLLOW_OP = 'pods.logs';

interface LogReadOptions {
    tailLines: number;
    sinceSeconds?: number;
    previous?: boolean;
    timestamps: boolean;
}

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
    // A body chunk can end inside a multi-byte character; the decoder keeps those bytes for the next.
    const decoder = new StringDecoder('utf8');
    const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            splitter.push(decoder.write(chunk));
            callback();
        },
    });
    sink.on('finish', () => {
        splitter.push(decoder.end());
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

    const options: LogReadOptions = {
        tailLines: input.tailLines ?? DEFAULT_TAIL_LINES,
        sinceSeconds: input.sinceSeconds,
        previous: input.previous,
        timestamps: true,
    };
    let controller: AbortController;
    try {
        controller = await new Log(kubeConfig()).log(target.namespace, target.name, target.container, sink, {
            ...options,
            follow: true,
        });
    } catch (error) {
        throw await followRefusal(target, options, error);
    }
    return {
        stop: () => {
            stopped = true;
            controller.abort();
            source?.destroy();
        },
    };
}

/**
 * Why the API server refused a follow. For any status but 200 and 500 the client library's follow
 * throws with no body and a message dumping the response headers, dropping the server's sentence
 * ("container is waiting to start"). The same read without `follow` keeps the Status body, so it
 * is asked once more and its failure classified; should it succeed, the follow's own status is.
 */
async function followRefusal(target: PodTarget, options: LogReadOptions, error: unknown): Promise<K8sError> {
    if (!(error instanceof ApiException)) return toK8sError(FOLLOW_OP, error);
    try {
        await withK8s(FOLLOW_OP, () => apis().core.readNamespacedPodLog({ ...target, ...options, tailLines: 1 }));
    } catch (reread) {
        if (reread instanceof K8sError && !isHeaderDump(reread.detail)) return reread;
    }
    const refused = toK8sError(FOLLOW_OP, error);
    if (!isHeaderDump(refused.detail)) return refused;
    return new K8sError(refused.kind, `The API server refused to stream this log (HTTP ${error.code}).`, FOLLOW_OP);
}

/** The text an `ApiException` without a Status body carries, which names no reason at all. */
function isHeaderDump(detail: string): boolean {
    return detail.startsWith('HTTP-Code:');
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
        const bytes = Buffer.from(raw, 'utf8');
        if (bytes.length <= LOG_DOWNLOAD_BYTES) return { text: raw, truncated: false };
        return { text: bytes.subarray(tailStart(bytes, LOG_DOWNLOAD_BYTES)).toString('utf8'), truncated: true };
    });
}

const NEWLINE = 0x0a;

/**
 * Where the newest `cap` bytes should begin so the file opens on a whole line: at the cut itself
 * when a line starts there, else after the first newline past it. A kept tail with no newline is
 * one line longer than the cap, which can only be kept in part, so it starts on the first whole
 * character instead of on a UTF-8 continuation byte.
 */
function tailStart(bytes: Buffer, cap: number): number {
    const cut = bytes.length - cap;
    if (bytes[cut - 1] === NEWLINE) return cut;
    const newline = bytes.indexOf(NEWLINE, cut);
    if (newline !== -1 && newline + 1 < bytes.length) return newline + 1;
    let start = cut;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    return start;
}
