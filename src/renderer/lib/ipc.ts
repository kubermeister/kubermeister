import type { IpcChannel, IpcInput, IpcOutput, IpcResult } from '../../shared/ipc';
import type { ManifestFile } from '../../shared/manifest-file';
import type { IpcError as IpcErrorShape, K8sErrorKind } from '../../shared/k8s/errors';
import type { SubChannel, SubPayload } from '../../shared/ipc-subscriptions';
import type { StreamChannel, StreamData, StreamInput, StreamMessage } from '../../shared/streams';

/** A classified failure returned by the main process, rethrown with its structure intact. */
export class IpcError extends Error {
    readonly kind: K8sErrorKind;
    readonly detail: string;
    readonly op: string;

    constructor(error: IpcErrorShape) {
        super(error.detail);
        this.name = 'IpcError';
        this.kind = error.kind;
        this.detail = error.detail;
        this.op = error.op;
    }
}

/**
 * Typed wrapper over the untyped `window.km` bridge and the one place the renderer casts
 * `unknown`. Every other module gets per-channel input and output types from the shared contract,
 * and expected failures arrive as {@link IpcError} rather than a message string to parse.
 */
export async function invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>> {
    const result = (await window.km.invoke(channel, input)) as IpcResult<IpcOutput<C>>;
    if (!result.ok) throw new IpcError(result.error);
    return result.data;
}

/**
 * Read a manifest the user dropped on the window. The renderer hands over the dropped `File` and
 * gets back text: only the preload can turn that file into a path, and only main reads it, so there
 * is no channel here through which a path could be named.
 */
export async function importDroppedFile(file: File): Promise<ManifestFile> {
    const result = (await window.km.importFile(file)) as IpcResult<ManifestFile>;
    if (!result.ok) throw new IpcError(result.error);
    return result.data;
}

/** Listen to a main-to-renderer push channel with its payload typed; returns the unsubscribe function. */
export function subscribe<C extends SubChannel>(channel: C, handler: (payload: SubPayload<C>) => void): () => void {
    return window.km.subscribe(channel, handler as (payload: unknown) => void);
}

export interface StreamHandle {
    stop: () => void;
    /** Feed input to a bidirectional stream; a no-op for one-directional ones. */
    send: (data: unknown) => void;
}

/** Open a typed stream over the bridge; messages carry the channel's data type. */
export function stream<C extends StreamChannel>(
    channel: C,
    input: StreamInput<C>,
    onMessage: (message: StreamMessage<StreamData<C>>) => void,
): StreamHandle {
    return window.km.stream(channel, input, onMessage as (message: unknown) => void);
}
