import type { ManifestExportInput, ManifestExportTarget, ManifestKind } from '../../../shared/k8s/manifest.js';
import { K8sError, withK8s } from '../errors.js';
import { yamlToText } from '../yaml.js';
import { listRawObjects, typeMeta, type RawItem } from './manifest.js';

/**
 * Saving a list selection as YAML. The objects are read as the Manifest tab reads one and
 * serialized by the same plain dump, so a file holds the objects the cluster holds; `clean` is the
 * other thing a reader may want, the objects as somebody would write them, which is what makes the
 * file applicable somewhere else. Everything here is pure over Kubernetes objects except the one
 * list per namespace, so the shaping is tested without a cluster.
 */

const OP = 'resources.exportYaml';

/**
 * The parts of `metadata` the API server owns. `ownerReferences` is one of them: it names a uid
 * this cluster issued, so an object applied elsewhere carrying it is collected the moment the
 * garbage collector fails to find that owner.
 */
const SERVER_METADATA = [
    'uid',
    'selfLink',
    'resourceVersion',
    'generation',
    'creationTimestamp',
    'deletionTimestamp',
    'deletionGracePeriodSeconds',
    'managedFields',
    'ownerReferences',
] as const;

/** Bookkeeping written by kubectl and the controllers, about this cluster's copy rather than the object. */
const SERVER_ANNOTATIONS = ['kubectl.kubernetes.io/last-applied-configuration', 'deployment.kubernetes.io/revision'];

interface Cleanable {
    kind?: unknown;
    status?: unknown;
    metadata?: Record<string, unknown> & { annotations?: Record<string, string> };
    spec?: Record<string, unknown>;
}

/**
 * The object as somebody would write it: `status` and the fields the API server filled in are gone,
 * so applying the result to another cluster creates the object rather than being refused for naming
 * an identity that cluster never issued. A copy is returned; the caller's object is untouched.
 */
export function cleanForExport<T extends object>(obj: T): T {
    const clone = structuredClone(obj) as T & Cleanable;
    delete clone.status;
    const meta = clone.metadata;
    if (meta) {
        for (const field of SERVER_METADATA) delete meta[field];
        for (const annotation of SERVER_ANNOTATIONS) delete meta.annotations?.[annotation];
        if (meta.annotations && Object.keys(meta.annotations).length === 0) delete meta.annotations;
    }
    // A Service's addresses come out of this cluster's own range, and another cluster refuses them;
    // `None` is not an address but the spelling of a headless Service, so it is the object's own.
    if (clone.kind === 'Service' && clone.spec) {
        if (clone.spec.clusterIP !== 'None') delete clone.spec.clusterIP;
        if (Array.isArray(clone.spec.clusterIPs) && !clone.spec.clusterIPs.includes('None'))
            delete clone.spec.clusterIPs;
    }
    dropNullCreationTimestamps(clone);
    return clone;
}

/**
 * `creationTimestamp: null` is what the API server prints for a pod template's own metadata, which
 * has no creation time at all; it is noise wherever it appears and nothing reads it back.
 */
function dropNullCreationTimestamps(value: unknown): void {
    if (Array.isArray(value)) {
        for (const item of value) dropNullCreationTimestamps(item);
        return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.creationTimestamp === null) delete record.creationTimestamp;
    for (const child of Object.values(record)) dropNullCreationTimestamps(child);
}

export interface ManifestExportFile {
    /** The whole file: one YAML document per object, in the order the selection named them. */
    text: string;
    /** How many objects the file holds; an object deleted since the list was read is left out. */
    count: number;
    /** What the save dialog offers as a name before the user changes it. */
    defaultName: string;
}

/** Selection id, namespace-qualified the way a list row's own id is, so a name is never ambiguous. */
function targetKey(target: ManifestExportTarget): string {
    return `${target.namespace ?? ''}/${target.name}`;
}

/**
 * The names to read per namespace. A selection of fifty rows in one namespace is one list, not
 * fifty reads of the same list, which is the whole reason the objects are not fetched one by one.
 */
function byNamespace(targets: readonly ManifestExportTarget[]): Map<string | undefined, Set<string>> {
    const groups = new Map<string | undefined, Set<string>>();
    for (const target of targets) {
        const names = groups.get(target.namespace) ?? new Set<string>();
        names.add(target.name);
        groups.set(target.namespace, names);
    }
    return groups;
}

function documentFor(kind: ManifestKind, item: RawItem, clean: boolean): string {
    const meta = typeMeta(kind);
    const manifest: Record<string, unknown> = { ...item };
    manifest.apiVersion ??= meta.apiVersion;
    manifest.kind ??= meta.kind;
    return yamlToText(clean ? cleanForExport(manifest) : manifest);
}

function defaultNameFor(kind: ManifestKind, targets: readonly ManifestExportTarget[]): string {
    return targets.length === 1 ? `${targets[0]!.name}.yaml` : `${kind.toLowerCase()}-export.yaml`;
}

/**
 * The selected objects as one multi-document YAML file. Nothing found at all is an error rather
 * than an empty file, since a file saying nothing is worse than being told why.
 */
export function exportManifests({ kind, targets, clean }: ManifestExportInput): Promise<ManifestExportFile> {
    return withK8s(OP, async () => {
        const documents = new Map<string, string>();
        for (const [namespace, names] of byNamespace(targets)) {
            const items = await listRawObjects(kind, namespace);
            for (const item of items) {
                const name = item.metadata?.name;
                if (!name || !names.has(name)) continue;
                documents.set(targetKey({ name, namespace }), documentFor(kind, item, clean));
            }
        }
        const ordered = targets
            .map((target) => documents.get(targetKey(target)))
            .filter((document): document is string => document !== undefined);
        if (ordered.length === 0) {
            const detail =
                targets.length === 1
                    ? `${typeMeta(kind).kind} "${targets[0]!.name}" was not found.`
                    : `None of the ${targets.length} selected ${typeMeta(kind).kind}s was found.`;
            throw new K8sError('notFound', detail, OP);
        }
        return { text: ordered.join('---\n'), count: ordered.length, defaultName: defaultNameFor(kind, targets) };
    });
}
