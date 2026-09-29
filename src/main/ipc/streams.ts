import { ipcMain, type WebContents } from 'electron';
import {
    streamSendSchema,
    streamStartSchema,
    streamStopSchema,
    type StreamChannel,
    type StreamController,
    type StreamSend,
} from '../../shared/streams.js';
import { startNodeDrain } from '../k8s/drain.js';
import { startPodExecStream } from '../k8s/exec.js';
import { toK8sError } from '../k8s/errors.js';
import { startPodLogStream } from '../k8s/logs.js';
import { startPodPortForward } from '../k8s/port-forward.js';
import { startResourceWatch } from '../k8s/watch.js';

/** A stream handler starts pushing through `send` and returns how to stop (and optionally write). */
export type StreamHandler = (input: unknown, send: StreamSend) => Promise<StreamController>;

const HANDLERS: Record<StreamChannel, StreamHandler> = {
    'resources.watch': startResourceWatch,
    'pods.logs': startPodLogStream,
    'pods.exec': startPodExecStream,
    'pods.portForward': startPodPortForward,
    'nodes.drain': startNodeDrain,
};

/**
 * Streams are keyed by `<webContents.id>:<subId>`, never by the raw subId. The preload mints
 * subIds from a per-renderer counter that resets on reload, so two windows produce identical ids;
 * the sender id keeps each window's streams private, and ownership is implicit: a `send` or `stop`
 * can only ever form a key with its own sender id.
 */
const streamKey = (senderId: number, subId: string): string => `${senderId}:${subId}`;

interface StreamEntry {
    sender: WebContents;
    /** Kept so main can end a stream on its own initiative and tell the renderer why. */
    send: StreamSend;
    /** Absent while the handler is still setting up (connecting, listing). */
    controller?: StreamController;
    /** Set when the stream was stopped before setup resolved; the controller is stopped on arrival. */
    cancelled: boolean;
}

/**
 * One entry per key, starting or live. A start is tracked against its window before its handler is
 * awaited, so a reload, a destroyed window or a crash sweeps it as well; each start owns its own
 * entry, so a cancelled start can never be revived by a later start reusing its subId.
 */
const streams = new Map<string, StreamEntry>();
const senderSubs = new Map<WebContents, Set<string>>();
const wiredSenders = new WeakSet<WebContents>();

function stop(key: string): void {
    const entry = streams.get(key);
    if (!entry) return;
    streams.delete(key);
    senderSubs.get(entry.sender)?.delete(key);
    if (entry.controller) entry.controller.stop();
    else entry.cancelled = true;
}

/** Track a stream against its window and, once per window, tear everything down on reload, crash or destroy. */
function track(sender: WebContents, key: string): void {
    let subs = senderSubs.get(sender);
    if (!subs) {
        subs = new Set();
        senderSubs.set(sender, subs);
    }
    subs.add(key);

    if (wiredSenders.has(sender)) return;
    wiredSenders.add(sender);
    const sweep = () => {
        const owned = senderSubs.get(sender);
        if (!owned) return;
        for (const id of [...owned]) stop(id);
        senderSubs.delete(sender);
    };
    // A full reload is a new document; in-page hash navigation is not.
    sender.on('did-start-navigation', (event) => {
        if (event.isMainFrame && !event.isSameDocument) sweep();
    });
    // Nobody is watching a crashed renderer's streams, and a reload may never come.
    sender.on('render-process-gone', sweep);
    sender.once('destroyed', sweep);
}

/**
 * Stop every stream, whoever owns it. Quitting relies on this: a renderer is not guaranteed to be
 * destroyed, and so swept, before the process tears down, and a log follow or an exec socket left
 * open can hold the shutdown open behind it.
 */
export function stopAllStreams(): void {
    for (const key of [...streams.keys()]) stop(key);
    senderSubs.clear();
}

/**
 * End every stream because the connection it was opened on is gone: a context switch or a new
 * kubeconfig. Each stream is told why and then ended, so a terminal prints the reason instead of
 * going quiet, and a port-forward stops listening rather than forwarding new connections to the
 * same-named pod in the next cluster. The streams all share the one live `KubeConfig`, which the
 * client library re-reads on every reconnect, so letting them run would re-target them. A stream
 * still starting is told at once too, since its setup may take as long as a credential plugin does.
 */
export function endAllStreams(reason: string): void {
    for (const [key, entry] of [...streams.entries()]) {
        stop(key);
        entry.send({ type: 'error', message: reason });
        entry.send({ type: 'end' });
    }
    senderSubs.clear();
}

export function registerStreamHandlers(): void {
    ipcMain.handle('stream.start', async (event, arg: unknown) => {
        const parsed = streamStartSchema.safeParse(arg);
        // A malformed envelope cannot be trusted to name a push event; drop it silently.
        if (!parsed.success) return;
        const { channel, subId, input } = parsed.data;
        const sender = event.sender;
        const key = streamKey(sender.id, subId);
        const send: StreamSend = (message) => {
            if (!sender.isDestroyed()) sender.send(`sub.${subId}`, message);
        };
        // A reused subId must not overwrite this window's stream, live or starting: stop it, then start fresh.
        stop(key);
        if (sender.isDestroyed()) return;
        const entry: StreamEntry = { sender, send, cancelled: false };
        streams.set(key, entry);
        track(sender, key);
        try {
            const controller = await HANDLERS[channel](input, send);
            if (entry.cancelled || sender.isDestroyed()) {
                if (streams.get(key) === entry) stop(key);
                controller.stop();
                return;
            }
            entry.controller = controller;
        } catch (error) {
            // A cancelled start was already ended; its subId may belong to a newer stream by now.
            if (entry.cancelled) return;
            stop(key);
            // Classified like any other cluster call, so the console reads the server's sentence
            // rather than the client library's HTTP dump.
            send({ type: 'error', message: toK8sError(channel, error).detail });
            send({ type: 'end' });
        }
    });

    ipcMain.handle('stream.send', (event, arg: unknown) => {
        const parsed = streamSendSchema.safeParse(arg);
        if (!parsed.success) return;
        streams.get(streamKey(event.sender.id, parsed.data.subId))?.controller?.write?.(parsed.data.data);
    });

    ipcMain.handle('stream.stop', (event, arg: unknown) => {
        const parsed = streamStopSchema.safeParse(arg);
        if (!parsed.success) return;
        stop(streamKey(event.sender.id, parsed.data.subId));
    });
}

/** Test hook: how many streams are live. */
export function activeStreamCount(): number {
    let live = 0;
    for (const entry of streams.values()) if (entry.controller) live++;
    return live;
}
