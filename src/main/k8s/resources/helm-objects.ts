import type { ReleaseObject, ReleaseStatusKind } from '../../../shared/k8s/addons.js';
import { RELEASE_STATUS_KINDS } from '../../../shared/k8s/addons.js';
import { ownerPath } from '../../../shared/k8s/owners.js';
import { KIND_REGISTRY, registeredKindOf } from '../../../shared/k8s/registry.js';
import type { RowOf } from '../../../shared/k8s/resources.js';
import { apis } from '../client.js';
import { K8sError, toK8sError, withK8s } from '../errors.js';
import { currentRelease, manifestObjects, objectKey, type RenderedObject } from './helm.js';
import { listRowsOf } from './index.js';

/*
 * A release's Resources tab: every object the current revision's stored manifest rendered, read
 * live. The manifest is the only source, so an object is the release's because Helm rendered it,
 * never because its name looks like the release's. The reads are one list per kind and namespace,
 * the way an export batches its reads, and everything else here is pure over the objects and what
 * those lists answered, so the shaping is tested without a cluster.
 */

const OP = 'releases.resources';

/** The status word each kind's own list row carries, read through that kind's own transform. */
const STATUS_OF: { [K in ReleaseStatusKind]: (row: RowOf<K>) => string } = {
    Pod: (row) => row.status,
    Deployment: (row) => row.status,
    Job: (row) => row.status,
    PodDisruptionBudget: (row) => row.status,
    Service: (row) => row.status,
    Ingress: (row) => row.status,
    PersistentVolume: (row) => row.status,
    PersistentVolumeClaim: (row) => row.status,
    VolumeSnapshot: (row) => row.ready,
    MutatingWebhookConfiguration: (row) => row.status,
    ValidatingWebhookConfiguration: (row) => row.status,
    APIService: (row) => row.status,
};

const isStatusKind = (kind: string | undefined): kind is ReleaseStatusKind =>
    RELEASE_STATUS_KINDS.includes(kind as ReleaseStatusKind);

/** One list the tab makes: a kind in a namespace, or cluster-wide for a cluster-scoped kind. */
export interface ReadGroup {
    key: string;
    apiVersion: string;
    kind: string;
    namespace?: string;
    /** Set when the rows come through the registered kind's own transform, which gives a status. */
    statusKind?: ReleaseStatusKind;
}

/**
 * What one list answered. `found` maps each listed name to its status word, or null for a kind with
 * none; a kind the server does not serve at all is an empty `found`, since nothing of it can exist.
 * `unreadable` is a list the app was refused, which says nothing about whether the objects exist.
 */
export type GroupAnswer = { found: Map<string, string | null> } | { unreadable: string };

/**
 * The list an object is read through. A kind with a status goes through its registered transform,
 * which knows its own API path, so any version of its group is the same list; every other kind is
 * listed at the manifest's own `apiVersion`, which is what lets a custom resource ride along.
 */
export function groupOf(object: RenderedObject): ReadGroup {
    const registered = registeredKindOf(object.apiVersion, object.kind);
    const namespace = registered && KIND_REGISTRY[registered].clusterScoped ? undefined : object.metadata.namespace;
    if (isStatusKind(registered)) {
        return {
            key: `${registered}|${namespace ?? ''}`,
            apiVersion: object.apiVersion,
            kind: object.kind,
            namespace,
            statusKind: registered,
        };
    }
    return {
        key: `${object.apiVersion}|${object.kind}|${namespace ?? ''}`,
        apiVersion: object.apiVersion,
        kind: object.kind,
        namespace,
    };
}

/** The lists the objects need: one per kind and namespace, however many objects share it. */
export function readGroups(objects: readonly RenderedObject[]): ReadGroup[] {
    const groups = new Map<string, ReadGroup>();
    for (const object of objects) {
        const group = groupOf(object);
        if (!groups.has(group.key)) groups.set(group.key, group);
    }
    return [...groups.values()];
}

/**
 * Each rendered object as the cluster holds it, in the order the manifest rendered them. An object
 * whose list was refused is Unknown rather than Missing, because a refusal is not an absence.
 */
export function toReleaseObjects(
    objects: readonly RenderedObject[],
    answers: ReadonlyMap<string, GroupAnswer>,
): ReleaseObject[] {
    const seen = new Set<string>();
    const rows: ReleaseObject[] = [];
    for (const object of objects) {
        const identity = objectKey(object);
        if (seen.has(identity)) continue;
        seen.add(identity);

        const group = groupOf(object);
        const { name } = object.metadata;
        const registered = registeredKindOf(object.apiVersion, object.kind);
        const path = registered ? ownerPath(object.kind, name, group.namespace ?? '') : null;
        const base = { apiVersion: object.apiVersion, kind: object.kind, name, namespace: group.namespace };
        const answer = answers.get(group.key);

        if (!answer || 'unreadable' in answer) {
            const note = answer?.unreadable ?? 'The cluster was not asked for this kind.';
            rows.push({ ...base, state: 'Unknown', status: null, path, note });
        } else if (!answer.found.has(name)) {
            // Nothing to open: the object's own screen would only say it is not there.
            rows.push({ ...base, state: 'Missing', status: null, path: null });
        } else {
            const value = answer.found.get(name) ?? null;
            const status = group.statusKind && value !== null ? { kind: group.statusKind, value } : null;
            rows.push({ ...base, state: 'Present', status, path });
        }
    }
    return rows;
}

/** A kind the server has no API for, which the client library reports before any request is made. */
const unserved = (error: unknown): boolean =>
    error instanceof Error && error.message.startsWith('Unrecognized API version and kind');

async function statusRows<K extends ReleaseStatusKind>(
    kind: K,
    namespace: string | undefined,
): Promise<Map<string, string | null>> {
    const rows = await listRowsOf(kind, namespace);
    const statusOf = STATUS_OF[kind] as (row: RowOf<K>) => string;
    return new Map(rows.map((row) => [row.name, statusOf(row)]));
}

async function listedNames(group: ReadGroup): Promise<Map<string, string | null>> {
    const list = await apis().objects.list(group.apiVersion, group.kind, group.namespace);
    return new Map(
        list.items
            .map((item) => item.metadata?.name)
            .filter((name): name is string => !!name)
            .map((name) => [name, null]),
    );
}

async function readGroup(group: ReadGroup): Promise<GroupAnswer> {
    try {
        const found = group.statusKind ? await statusRows(group.statusKind, group.namespace) : await listedNames(group);
        return { found };
    } catch (error) {
        if (unserved(error)) return { found: new Map() };
        const classified = toK8sError(OP, error);
        if (classified.kind === 'notFound') return { found: new Map() };
        if (classified.kind === 'forbidden') {
            const where = group.namespace ? ` in namespace ${group.namespace}` : '';
            return { unreadable: `Not allowed to list ${group.kind} objects${where}.` };
        }
        // Anything else (a timeout, the cluster going away) is the whole tab's failure, not one row's.
        throw classified;
    }
}

export function getReleaseObjects(name: string, namespace: string): Promise<ReleaseObject[]> {
    return withK8s(OP, async () => {
        const release = await currentRelease(name, namespace);
        if (!release) throw new K8sError('notFound', `No Helm release "${name}" in namespace ${namespace}.`, OP);
        const objects = manifestObjects(release.manifest, namespace);
        const groups = readGroups(objects);
        const answers = await Promise.all(groups.map(async (group) => [group.key, await readGroup(group)] as const));
        return toReleaseObjects(objects, new Map(answers));
    });
}
