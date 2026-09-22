import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS, STREAM_CHANNELS, SUBSCRIPTION_CHANNELS } from '../shared/ipc-channels.js';

/** Channels the renderer may reach. Anything else is rejected here, before it leaves the sandbox. */
const allowed = new Set<string>(IPC_CHANNELS);
const subscribable = new Set<string>(SUBSCRIPTION_CHANNELS);
const streamable = new Set<string>(STREAM_CHANNELS);

let streamSeq = 0;

contextBridge.exposeInMainWorld('km', {
    invoke: (channel: string, input: unknown): Promise<unknown> => {
        if (!allowed.has(channel)) return Promise.reject(new Error(`blocked IPC channel: ${channel}`));
        return ipcRenderer.invoke(channel, input);
    },

    /** Listen to a main-to-renderer push channel; returns the unsubscribe function. */
    subscribe: (channel: string, handler: (payload: unknown) => void): (() => void) => {
        if (!subscribable.has(channel)) throw new Error(`blocked subscription channel: ${channel}`);
        const eventName = `sub.${channel}`;
        const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
        ipcRenderer.on(eventName, listener);
        return () => {
            ipcRenderer.removeListener(eventName, listener);
        };
    },

    /**
     * Read a manifest the user dropped on the window. `webUtils.getPathForFile` is the only way a
     * sandboxed renderer learns where a dropped file lives — `File.path` is gone — and it answers
     * for files the browser process made from a real drag, never for one the page constructed. The
     * read itself is not in the channel list `invoke` checks, so this is the only way to reach it
     * and the renderer can never name a path of its own.
     */
    importFile: (file: File): Promise<unknown> => {
        const path = webUtils.getPathForFile(file);
        if (!path) {
            return Promise.resolve({
                ok: false,
                error: { kind: 'invalid', detail: 'That is not a file on disk.', op: 'manifest.read' },
            });
        }
        return ipcRenderer.invoke('manifest.read', { path });
    },

    /**
     * Open a stream: listen on a unique `sub.<subId>` event, then ask main to start it, so no early
     * message is missed. Returns a stop function and, for bidirectional streams, a send function.
     */
    stream: (channel: string, input: unknown, onMessage: (message: unknown) => void) => {
        if (!streamable.has(channel)) throw new Error(`blocked stream channel: ${channel}`);
        const subId = `stream:${channel}:${++streamSeq}`;
        const eventName = `sub.${subId}`;
        const listener = (_event: Electron.IpcRendererEvent, message: unknown) => onMessage(message);
        ipcRenderer.on(eventName, listener);
        void ipcRenderer.invoke('stream.start', { channel, subId, input });
        return {
            stop: () => {
                ipcRenderer.removeListener(eventName, listener);
                void ipcRenderer.invoke('stream.stop', { subId });
            },
            send: (data: unknown) => {
                void ipcRenderer.invoke('stream.send', { subId, data });
            },
        };
    },
});
