import { z } from 'zod';

/**
 * Coarse classification of why a cluster call failed, shown to the user. `unreachable` is a
 * connection that never came up (refused, DNS, TLS, connect timeout); `timeout` is a server that was
 * reached but did not finish answering within the app's read ceiling, which on a busy cluster or a
 * slow link is a different problem with a different fix. `kubeconfig` is a file that would not load
 * at all, which no cluster call can get past until it is fixed or another is chosen.
 */
export const k8sErrorKindSchema = z.enum([
    'kubeconfig',
    'unreachable',
    'timeout',
    'forbidden',
    'unauthorized',
    'notFound',
    'conflict',
    'invalid',
    'unknown',
]);

/**
 * A classified failure carried inside the IPC result envelope instead of a thrown exception, so the
 * renderer receives structure rather than a message string to parse.
 */
export const ipcErrorSchema = z.object({
    kind: k8sErrorKindSchema,
    /** Human-readable reason, safe to show. */
    detail: z.string(),
    /** The operation that failed, e.g. `nodes.list`. */
    op: z.string(),
});

export type K8sErrorKind = z.infer<typeof k8sErrorKindSchema>;
export type IpcError = z.infer<typeof ipcErrorSchema>;
