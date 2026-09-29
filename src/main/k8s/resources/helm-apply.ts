import { ApiException, PatchStrategy, type KubernetesObject, type V1ManagedFieldsEntry } from '@kubernetes/client-node';
import { apis } from '../client.js';
import { K8sError } from '../errors.js';
import { withHelmOwnership, type RenderedObject } from './helm.js';

/*
 * Writing a release's objects the way Helm 4 does: server-side apply under Helm's own field manager,
 * never forcing a conflict. The API server then keeps what other managers set — replicas an
 * autoscaler or `kubectl scale` owns, an annotation a tool added — and removes a field only Helm set
 * that the new render no longer has, which is the three-way merge Helm 3 did by hand.
 */

/**
 * The field manager Helm applies as: the Helm CLI names itself after its binary, `helm`, so an object
 * applied here and one applied by the CLI are owned by one manager and neither conflicts with the other.
 */
export const HELM_FIELD_MANAGER = 'helm';

/** Apply one rendered object for a release, carrying Helm's ownership metadata, as Helm 4 applies it. */
export function applyForRelease<T extends KubernetesObject>(
    rendered: RenderedObject,
    release: string,
    namespace: string,
    options: { dryRun?: boolean; force?: boolean } = {},
): Promise<T> {
    const object = withHelmOwnership(structuredClone(rendered), release, namespace);
    return apis().objects.patch(
        object,
        undefined,
        options.dryRun ? 'All' : undefined,
        HELM_FIELD_MANAGER,
        options.force ?? false,
        PatchStrategy.ServerSideApply,
    ) as Promise<T>;
}

export interface ApplyConflict {
    /** The field path the API server names, such as `.spec.replicas`. */
    field: string;
    manager: string;
}

/** The conflicts a refused apply names, or null when the error is not an apply conflict. */
export function applyConflicts(error: unknown): ApplyConflict[] | null {
    if (!(error instanceof ApiException) || error.code !== 409) return null;
    const body = error.body as { details?: { causes?: { type?: string; message?: string; field?: string }[] } } | null;
    const causes = (body?.details?.causes ?? []).filter((cause) => cause.type === 'FieldManagerConflict');
    if (causes.length === 0) return null;
    return causes.map((cause) => ({
        field: cause.field ?? '',
        manager: /conflict with "([^"]*)"/.exec(cause.message ?? '')?.[1] ?? 'another manager',
    }));
}

/** A refused apply as a sentence naming each field and who owns it, the way Helm 4 refuses it. */
export function conflictError(op: string, what: string, conflicts: ApplyConflict[]): K8sError {
    const fields = conflicts.map((one) => `${one.field} is managed by "${one.manager}"`).join('; ');
    return new K8sError(
        'conflict',
        `${what}: ${fields}. Helm does not take over a field another manager set; give it back, or leave it out of the chart's values.`,
        op,
    );
}

type FieldSet = Record<string, unknown>;

function mergeFields(into: FieldSet, from: FieldSet): FieldSet {
    const out: FieldSet = { ...into };
    for (const [key, value] of Object.entries(from)) {
        const existing = out[key];
        out[key] =
            existing && typeof existing === 'object' && value && typeof value === 'object'
                ? mergeFields(existing as FieldSet, value as FieldSet)
                : value;
    }
    return out;
}

const isClientSide = (entry: V1ManagedFieldsEntry) =>
    entry.manager === HELM_FIELD_MANAGER && entry.operation === 'Update' && !entry.subresource;

/**
 * The managed fields of an object Helm wrote client-side, with that ownership moved onto Helm's apply
 * entry, as `helm upgrade --server-side` does before its first apply (Kubernetes' `csaupgrade`).
 * Without it, Helm's own earlier writes would conflict with Helm's apply, and a field only they set
 * would never be removed. Null when Helm holds nothing client-side.
 */
export function clientSideOwnership(object: KubernetesObject): V1ManagedFieldsEntry[] | null {
    const entries = object.metadata?.managedFields ?? [];
    const clientSide = entries.filter(isClientSide);
    if (clientSide.length === 0) return null;
    const applied = entries.find(
        (entry) => entry.manager === HELM_FIELD_MANAGER && entry.operation === 'Apply' && !entry.subresource,
    );
    const newest = clientSide[clientSide.length - 1]!;
    const fields = [...(applied ? [applied] : []), ...clientSide].reduce<FieldSet>(
        (all, entry) => mergeFields(all, (entry.fieldsV1 ?? {}) as FieldSet),
        {},
    );
    const merged: V1ManagedFieldsEntry = {
        manager: HELM_FIELD_MANAGER,
        operation: 'Apply',
        apiVersion: applied?.apiVersion ?? newest.apiVersion,
        time: newest.time ?? applied?.time,
        fieldsType: 'FieldsV1',
        fieldsV1: fields,
    };
    const rest = entries.filter((entry) => entry !== applied && !isClientSide(entry));
    return [...rest, merged];
}

/**
 * Move Helm's client-side ownership of a live object onto its apply entry, conditional on the version
 * it was read at, so a write in between makes this fail rather than overwrite what that write owns.
 */
export async function moveClientSideOwnership(live: KubernetesObject): Promise<boolean> {
    const managedFields = clientSideOwnership(live);
    if (!managedFields) return false;
    await apis().objects.patch(
        {
            apiVersion: live.apiVersion,
            kind: live.kind,
            metadata: {
                name: live.metadata?.name,
                namespace: live.metadata?.namespace,
                resourceVersion: live.metadata?.resourceVersion,
                managedFields,
            },
        },
        undefined,
        undefined,
        HELM_FIELD_MANAGER,
        undefined,
        PatchStrategy.MergePatch,
    );
    return true;
}
