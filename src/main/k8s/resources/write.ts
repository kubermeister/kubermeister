import type { KubernetesObject, V1APIResource, V1Scale } from '@kubernetes/client-node';
import { load as loadYaml } from 'js-yaml';
import { isClusterScopedManifestKind, type ManifestKind } from '../../../shared/k8s/manifest.js';
import { apiGroupOf, KIND_REGISTRY, knownKindScope, type Kind } from '../../../shared/k8s/registry.js';
import {
    identityKind,
    type DeleteInput,
    type ManifestIdentity,
    type ManifestWrite,
    type RestartInput,
    type ScaleInput,
    type WriteResult,
} from '../../../shared/k8s/write.js';
import { activeContextName, apis, getActiveNamespace } from '../client.js';
import { K8sError, withK8s } from '../errors.js';

/*
 * The write path. Creates and replaces go through the generic object client, which derives the API
 * path from the manifest's own apiVersion and kind, so a custom resource rides the same call as a
 * Pod. Deletes and scales are addressed by kind instead, since there is no manifest to read it from.
 *
 * Every write fails closed on its target. The context the screen believed active must be the one
 * main is on; a namespaced object must name its namespace, explicitly or through the active
 * selection, and is never left to the client library's own default; and a replace must aim at the
 * very object the editor was opened on.
 */

/** Parse a single-document manifest, rejecting anything unusable before the cluster sees it. */
export function parseManifest(manifestYaml: string, op: string): KubernetesObject {
    // An empty document is reported as its own parse failure by the YAML reader, which reads as a
    // syntax error rather than what it is: nothing to apply.
    if (manifestYaml.trim() === '') {
        throw new K8sError('invalid', 'The manifest must be a single YAML object.', op);
    }
    let parsed: unknown;
    try {
        parsed = loadYaml(manifestYaml);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new K8sError('invalid', `The manifest is not valid YAML: ${reason}`, op);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new K8sError('invalid', 'The manifest must be a single YAML object.', op);
    }
    const obj = parsed as KubernetesObject;
    if (!obj.apiVersion || !obj.kind) {
        throw new K8sError('invalid', 'The manifest must declare apiVersion and kind.', op);
    }
    if (!obj.metadata?.name && !obj.metadata?.generateName) {
        throw new K8sError('invalid', 'The manifest must declare metadata.name.', op);
    }
    return obj;
}

/**
 * The screen stamps every write with the context it was rendered under. Rows and detail pages can
 * outlive a context switch by a refetch round trip, so without this check a delete issued from the
 * previous cluster's rows would land on the same-named object in the new one.
 */
export function assertContext(expected: string, op: string): void {
    const actual = activeContextName();
    if (expected !== actual) {
        throw new K8sError(
            'conflict',
            `This action was meant for context "${expected}" but the app is now on "${actual}". Reload the screen and try again.`,
            op,
        );
    }
}

/**
 * Whether a manifest kind lives in a namespace. Registered kinds and the known cluster-scoped
 * extras answer from the registry when their API group matches as well as their name; anything
 * else, a custom resource typically, even one named like a built-in kind, is asked of the API
 * server's discovery so a cluster-scoped CR is never stamped with a namespace and a namespaced one
 * never slips through without.
 */
async function isNamespacedKind(spec: KubernetesObject, op: string): Promise<boolean> {
    const kind = spec.kind!;
    const scope = knownKindScope(spec.apiVersion!, kind);
    if (scope) return scope === 'namespaced';
    const resource = await discoverResource(spec.apiVersion!, kind);
    if (!resource) throw new K8sError('invalid', `The API server does not know ${spec.apiVersion} ${kind}.`, op);
    return resource.namespaced;
}

/**
 * The object client keeps its discovery lookup to itself, but it is the one place that already
 * knows how to resolve an apiVersion/kind pair against the server, so it is reused here rather
 * than duplicated.
 */
function discoverResource(apiVersion: string, kind: string): Promise<V1APIResource | undefined> {
    const client = apis().objects as unknown as {
        resource: (apiVersion: string, kind: string) => Promise<V1APIResource | undefined>;
    };
    return client.resource(apiVersion, kind);
}

/**
 * Give a namespaced manifest its namespace: the one it states, else the active selection. With
 * neither, refuse rather than let the client library pick the kubeconfig's default, which the user
 * never saw. A cluster-scoped kind is never given one.
 */
async function resolveManifestNamespace(spec: KubernetesObject, op: string): Promise<void> {
    if (!(await isNamespacedKind(spec, op))) {
        delete spec.metadata!.namespace;
        return;
    }
    if (spec.metadata!.namespace) return;
    const active = getActiveNamespace();
    if (!active) {
        throw new K8sError(
            'invalid',
            `${spec.kind} "${spec.metadata!.name ?? spec.metadata!.generateName}" needs a namespace: select one or add metadata.namespace.`,
            op,
        );
    }
    spec.metadata!.namespace = active;
}

/**
 * Create one object from a manifest. A dry run puts the object through the full admission chain and
 * persists nothing, which is how the editor checks a manifest before writing it.
 */
export function createResource(input: ManifestWrite): Promise<WriteResult> {
    const op = 'resources.create';
    return withK8s(op, async () => {
        assertContext(input.context, op);
        const spec = parseManifest(input.manifest, op);
        await resolveManifestNamespace(spec, op);
        const created = await apis().objects.create(spec, undefined, input.dryRun ? 'All' : undefined);
        return {
            kind: created.kind ?? spec.kind!,
            name: created.metadata?.name ?? spec.metadata!.name ?? '',
            namespace: created.metadata?.namespace ?? spec.metadata!.namespace,
        };
    });
}

/** The manifest must still describe the object the editor was opened on, or the save is aimed elsewhere. */
function assertIdentity(spec: KubernetesObject, expect: ManifestIdentity, op: string): void {
    // A custom resource has no registry entry, and its own kind is already the canonical name.
    const known = identityKind(expect);
    const kind = known ? factsFor(known).kind : expect.kind;
    // Any version of the group may be written back, but not another group's same-named kind.
    const sameGroup = expect.apiVersion === undefined || apiGroupOf(spec.apiVersion!) === apiGroupOf(expect.apiVersion);
    const typeOf = (apiVersion: string | undefined, name: string | undefined) =>
        sameGroup ? name : `${apiVersion} ${name}`;
    const actual = `${typeOf(spec.apiVersion, spec.kind)} "${spec.metadata?.namespace ? `${spec.metadata.namespace}/` : ''}${spec.metadata?.name}"`;
    const wanted = `${typeOf(expect.apiVersion, kind)} "${expect.namespace ? `${expect.namespace}/` : ''}${expect.name}"`;
    const sameNamespace = (spec.metadata?.namespace || undefined) === expect.namespace;
    if (!sameGroup || spec.kind !== kind || spec.metadata?.name !== expect.name || !sameNamespace) {
        throw new K8sError(
            'invalid',
            `The manifest describes ${actual}, but this editor is for ${wanted}. Restore the kind, name and namespace, or use Create resource for a new object.`,
            op,
        );
    }
}

/**
 * Replace one object from a manifest. The manifest must carry the resource version it was read
 * with: that is what turns a concurrent change into a rejection instead of a silent overwrite.
 */
export function replaceResource(input: ManifestWrite): Promise<WriteResult> {
    const op = 'resources.replace';
    return withK8s(op, async () => {
        assertContext(input.context, op);
        const spec = parseManifest(input.manifest, op);
        if (!spec.metadata?.name) {
            throw new K8sError('invalid', 'The manifest must declare metadata.name.', op);
        }
        if (!spec.metadata.resourceVersion) {
            throw new K8sError(
                'invalid',
                'The manifest must carry metadata.resourceVersion. Reload the object before saving.',
                op,
            );
        }
        if (input.expect) assertIdentity(spec, input.expect, op);
        await resolveManifestNamespace(spec, op);
        const updated = await apis().objects.replace(spec, undefined, input.dryRun ? 'All' : undefined);
        return {
            kind: updated.kind ?? spec.kind!,
            name: updated.metadata?.name ?? spec.metadata.name,
            namespace: updated.metadata?.namespace ?? spec.metadata.namespace,
        };
    });
}

const NODE_FACTS = { apiVersion: 'v1', kind: 'Node', clusterScoped: true };
const NAMESPACE_FACTS = { apiVersion: 'v1', kind: 'Namespace', clusterScoped: true };

function factsFor(kind: ManifestKind): { apiVersion: string; kind: string; clusterScoped: boolean } {
    if (kind === 'Node') return NODE_FACTS;
    if (kind === 'Namespace') return NAMESPACE_FACTS;
    const info = KIND_REGISTRY[kind];
    return { apiVersion: info.apiVersion, kind: info.kind, clusterScoped: info.clusterScoped };
}

/**
 * The namespace a destructive write addresses. The caller names it for a namespaced kind and omits
 * it for a cluster-scoped one; the active selection is never consulted, so a screen can only ever
 * act on the object it displayed. The schema enforces the same rule at the boundary; this is the
 * guard for direct callers.
 */
function targetNamespace(
    kind: ManifestKind,
    name: string,
    namespace: string | undefined,
    op: string,
): string | undefined {
    const clusterScoped = isClusterScopedManifestKind(kind);
    if (clusterScoped) return undefined;
    if (!namespace) {
        throw new K8sError('invalid', `A namespace is required to address ${factsFor(kind).kind} "${name}".`, op);
    }
    return namespace;
}

/** Delete one object in exactly the namespace the caller named. */
export function deleteResource(input: DeleteInput): Promise<WriteResult> {
    const op = 'resources.delete';
    return withK8s(op, async () => {
        assertContext(input.context, op);
        const facts = factsFor(input.kind);
        const target = targetNamespace(input.kind, input.name, input.namespace, op);
        await apis().objects.delete(
            {
                apiVersion: facts.apiVersion,
                kind: facts.kind,
                metadata: { name: input.name, namespace: target },
            },
            undefined,
            undefined,
            input.gracePeriodSeconds,
        );
        return { kind: facts.kind, name: input.name, namespace: target };
    });
}

/**
 * The annotation a rollout restart stamps. It is the key kubectl writes, deliberately: a restart
 * from here and one from the command line then read as the same event on the object's history
 * rather than as two competing conventions.
 */
export const RESTART_ANNOTATION = 'kubectl.kubernetes.io/restartedAt';

/** A patch that touches nothing but the pod template's annotations. */
interface TemplateStamp extends KubernetesObject {
    spec: { template: { metadata: { annotations: Record<string, string> } } };
}

/**
 * Restart one workload by stamping its pod template, which is what makes the controller roll its
 * pods: the cluster replaces them at the kind's own update strategy rather than deleting any here.
 * A strategic merge patch keeps every other field of the template as it is.
 */
export function restartResource(input: RestartInput): Promise<WriteResult> {
    const op = 'resources.restart';
    return withK8s(op, async () => {
        assertContext(input.context, op);
        const info = KIND_REGISTRY[input.kind];
        const target = targetNamespace(input.kind, input.name, input.namespace, op)!;
        const stamp: TemplateStamp = {
            apiVersion: info.apiVersion,
            kind: info.kind,
            metadata: { name: input.name, namespace: target },
            spec: { template: { metadata: { annotations: { [RESTART_ANNOTATION]: new Date().toISOString() } } } },
        };
        await apis().objects.patch(stamp);
        return { kind: info.kind, name: input.name, namespace: target };
    });
}

interface ScaleOps {
    read: (name: string, namespace: string) => Promise<V1Scale>;
    replace: (name: string, namespace: string, body: V1Scale) => Promise<V1Scale>;
}

/** The scale subresource of each kind the registry marks scalable; read lazily so a context switch is honoured. */
const SCALERS: Partial<Record<Kind, ScaleOps>> = {
    Deployment: {
        read: (name, namespace) => apis().apps.readNamespacedDeploymentScale({ name, namespace }),
        replace: (name, namespace, body) => apis().apps.replaceNamespacedDeploymentScale({ name, namespace, body }),
    },
    StatefulSet: {
        read: (name, namespace) => apis().apps.readNamespacedStatefulSetScale({ name, namespace }),
        replace: (name, namespace, body) => apis().apps.replaceNamespacedStatefulSetScale({ name, namespace, body }),
    },
};

/**
 * Scale one object: read the current scale for its resource version, set the desired count and put
 * it back, so a concurrent change is rejected rather than lost. Both scalable kinds are namespaced.
 */
export function scaleResource(input: ScaleInput): Promise<WriteResult> {
    const op = 'resources.scale';
    return withK8s(op, async () => {
        assertContext(input.context, op);
        const info = KIND_REGISTRY[input.kind];
        const ops = SCALERS[input.kind];
        if (!info.scalable || !ops) throw new K8sError('invalid', `${info.kind} cannot be scaled.`, op);

        const target = targetNamespace(input.kind, input.name, input.namespace, op)!;
        const scale = await ops.read(input.name, target);
        scale.spec = { ...(scale.spec ?? {}), replicas: input.replicas };
        await ops.replace(input.name, target, scale);
        return { kind: info.kind, name: input.name, namespace: target };
    });
}
