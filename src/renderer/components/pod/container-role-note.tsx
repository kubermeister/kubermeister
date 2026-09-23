import type { ContainerRole } from '../../../shared/k8s/pods';

/** "init" or "ephemeral" beside a container's name in a picker; nothing for the app's own. */
export function ContainerRoleNote({ role }: { role?: ContainerRole }) {
    if (!role || role === 'app') return null;
    return <span className="ml-auto pl-3 text-meta text-text-muted">{role}</span>;
}
