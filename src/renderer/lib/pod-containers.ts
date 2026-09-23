import type { ContainerRole } from '../../shared/k8s/pods';

const ORDER: readonly ContainerRole[] = ['app', 'init', 'ephemeral'];

/**
 * The containers a tab can open, app containers first. The pod spec lists init containers ahead of
 * the app, and a tab defaults to the first choice, so the order is what decides that a pod's Logs
 * and Shell open on the container running the app rather than on a finished init step.
 */
export function containerChoices<T extends { name: string; role: ContainerRole }>(
    containers: readonly T[] | undefined,
    roles: readonly ContainerRole[],
): T[] {
    return ORDER.filter((role) => roles.includes(role)).flatMap((role) =>
        (containers ?? []).filter((container) => container.role === role),
    );
}
