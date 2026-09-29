import type { V1LabelSelector, V1Pod, V1PodSpec, V1Service } from '@kubernetes/client-node';
import type { RelatedGroup, RelatedLink } from '../../../shared/k8s/related.js';
import { ownerPath } from '../../../shared/k8s/owners.js';
import { KIND_REGISTRY, type Kind } from '../../../shared/k8s/registry.js';
import { apis, readOrNull, resolveObjectNamespace } from '../client.js';
import { K8sError, withK8s } from '../errors.js';

/*
 * What else an object is tied to, answered from the object itself rather than from a guess: the
 * volumes and environment its containers actually name, the services whose selector actually
 * covers its labels, and the account it actually runs as.
 */

// A pod spec names these by kind alone, and always means the built-in one.
const link = (kind: Kind, name: string, namespace: string, why: string): RelatedLink => ({
    kind,
    name,
    namespace,
    path: ownerPath(KIND_REGISTRY[kind].apiVersion, kind, name, namespace),
    why,
});

/** Whether a selector covers a set of labels. An empty selector selects nothing, as the API has it. */
export function selectorCovers(selector: Record<string, string> | undefined, labels: Record<string, string>): boolean {
    const entries = Object.entries(selector ?? {});
    if (entries.length === 0) return false;
    return entries.every(([key, value]) => labels[key] === value);
}

/**
 * Whether a label selector selects a set of labels, read as the API server reads one: an empty
 * selector selects everything, an absent one nothing, and every label and expression must hold. An
 * operator the API does not know makes the selector invalid there, so it selects nothing here either.
 */
export function labelSelectorSelects(
    selector: V1LabelSelector | null | undefined,
    labels: Record<string, string>,
): boolean {
    if (!selector) return false;
    const matchLabels = Object.entries(selector.matchLabels ?? {}).every(([key, value]) => labels[key] === value);
    return (
        matchLabels &&
        (selector.matchExpressions ?? []).every(({ key, operator, values }) => {
            const has = Object.hasOwn(labels, key);
            switch (operator) {
                case 'In':
                    return has && (values ?? []).includes(labels[key]!);
                case 'NotIn':
                    return !has || !(values ?? []).includes(labels[key]!);
                case 'Exists':
                    return has;
                case 'DoesNotExist':
                    return !has;
                default:
                    return false;
            }
        })
    );
}

/** The config maps, secrets and claims a pod spec names, each with the way it names them. */
export function specReferences(spec: V1PodSpec | undefined, namespace: string): RelatedLink[] {
    const links: RelatedLink[] = [];
    const seen = new Set<string>();
    const add = (kind: Kind, name: string | undefined, why: string) => {
        if (!name) return;
        const key = `${kind}/${name}/${why}`;
        if (seen.has(key)) return;
        seen.add(key);
        links.push(link(kind, name, namespace, why));
    };

    for (const volume of spec?.volumes ?? []) {
        add('ConfigMap', volume.configMap?.name, `mounted as volume “${volume.name}”`);
        add('Secret', volume.secret?.secretName, `mounted as volume “${volume.name}”`);
        add('PersistentVolumeClaim', volume.persistentVolumeClaim?.claimName, `mounted as volume “${volume.name}”`);
        for (const source of volume.projected?.sources ?? []) {
            add('ConfigMap', source.configMap?.name, `projected into “${volume.name}”`);
            add('Secret', source.secret?.name, `projected into “${volume.name}”`);
        }
    }

    const containers = [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])];
    for (const container of containers) {
        for (const from of container.envFrom ?? []) {
            add('ConfigMap', from.configMapRef?.name, `envFrom in ${container.name}`);
            add('Secret', from.secretRef?.name, `envFrom in ${container.name}`);
        }
        for (const env of container.env ?? []) {
            add('ConfigMap', env.valueFrom?.configMapKeyRef?.name, `env ${env.name} in ${container.name}`);
            add('Secret', env.valueFrom?.secretKeyRef?.name, `env ${env.name} in ${container.name}`);
        }
    }

    for (const pull of spec?.imagePullSecrets ?? []) add('Secret', pull.name, 'image pull secret');
    add('ServiceAccount', spec?.serviceAccountName, 'runs as');
    return links;
}

/** The services whose selector covers these labels, which is what actually routes traffic to them. */
export function servicesFor(services: V1Service[], labels: Record<string, string>, namespace: string): RelatedLink[] {
    return services
        .filter((service) => selectorCovers(service.spec?.selector, labels))
        .map((service) => link('Service', service.metadata?.name ?? '', namespace, 'selects these pods'));
}

const grouped = (links: RelatedLink[]): RelatedGroup[] => {
    const of = (label: string, kinds: string[]) => ({
        label,
        items: links.filter((one) => kinds.includes(one.kind)),
    });
    return [
        of('Traffic', ['Service', 'Ingress', 'NetworkPolicy']),
        of('Configuration', ['ConfigMap', 'Secret']),
        of('Storage', ['PersistentVolumeClaim']),
        of('Access', ['ServiceAccount']),
    ].filter((group) => group.items.length > 0);
};

/** Everything tied to one pod: what it mounts and reads, what routes to it, and what it runs as. */
export function getRelated(kind: string, name: string, namespace?: string): Promise<RelatedGroup[]> {
    const op = 'resources.related';
    return withK8s(op, async () => {
        const ns = resolveObjectNamespace(namespace);
        if (!ns) throw new K8sError('invalid', `A namespace is required to relate ${kind} "${name}".`, op);
        if (kind !== 'Pod') return [];

        const pod = await readOrNull(() => apis().core.readNamespacedPod({ name, namespace: ns }));
        if (!pod) throw new K8sError('notFound', `Pod "${name}" was not found.`, op);
        const labels = (pod as V1Pod).metadata?.labels ?? {};
        const [services, policies] = await Promise.all([
            apis().core.listNamespacedService({ namespace: ns }),
            apis().net.listNamespacedNetworkPolicy({ namespace: ns }),
        ]);

        const links = [
            ...servicesFor(services.items, labels, ns),
            ...policies.items
                // The pod selector is required and `{}` is its empty form, which selects every pod.
                .filter((policy) => labelSelectorSelects(policy.spec?.podSelector ?? {}, labels))
                .map((policy) => link('NetworkPolicy', policy.metadata?.name ?? '', ns, 'applies to these pods')),
            ...specReferences(pod.spec, ns),
        ];
        return grouped(links);
    });
}
