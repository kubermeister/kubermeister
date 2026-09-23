import { apis } from './client.js';
import { readOrNull } from './client.js';
import type { ContainerRole } from '../../shared/k8s/pods.js';
import type { StreamController, StreamSend } from '../../shared/streams.js';

export interface PodTarget {
    name: string;
    namespace: string;
    container: string;
}

/**
 * A log can be read from any container the pod has run, and a failed init container is exactly
 * where one looks; exec needs a process to attach to, which an init container has usually finished.
 */
export const LOG_CONTAINER_ROLES: readonly ContainerRole[] = ['app', 'init', 'ephemeral'];
export const EXEC_CONTAINER_ROLES: readonly ContainerRole[] = ['app', 'ephemeral'];

/**
 * Resolve the container a pod stream addresses: the requested one when it has one of `roles`, else
 * the pod's first app container. Null when the pod does not exist or the name is not a container of
 * an accepted role, which the caller reports as a stream error.
 */
export async function resolvePodTarget(
    name: string,
    namespace: string,
    container?: string,
    roles: readonly ContainerRole[] = LOG_CONTAINER_ROLES,
): Promise<PodTarget | null> {
    const pod = await readOrNull(() => apis().core.readNamespacedPod({ name, namespace }));
    if (!pod) return null;
    const names: Record<ContainerRole, string[]> = {
        app: pod.spec?.containers?.map((c) => c.name) ?? [],
        init: pod.spec?.initContainers?.map((c) => c.name) ?? [],
        ephemeral: pod.spec?.ephemeralContainers?.map((c) => c.name) ?? [],
    };
    const chosen = container ?? names.app[0];
    if (!chosen || !roles.some((role) => names[role].includes(chosen))) return null;
    return { name, namespace, container: chosen };
}

/** The controller a stream returns when it could not even start. */
export const NOOP_CONTROLLER: StreamController = { stop: () => {} };

export function reportMissingPod(
    send: StreamSend,
    name: string,
    namespace: string,
    container?: string,
): StreamController {
    const what = container ? `container "${container}" of pod "${namespace}/${name}"` : `pod "${namespace}/${name}"`;
    send({ type: 'error', message: `${what} not found` });
    send({ type: 'end' });
    return NOOP_CONTROLLER;
}
