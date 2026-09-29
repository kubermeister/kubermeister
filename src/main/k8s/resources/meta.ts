import type { ManifestKind } from '../../../shared/k8s/manifest.js';
import type { ObjectMeta } from '../../../shared/k8s/meta.js';
import { ownerPath } from '../../../shared/k8s/owners.js';
import { K8sError, withK8s } from '../errors.js';
import { controllerRef } from './controller.js';
import { findRawObject } from './manifest.js';

/**
 * The two parts of `metadata` every detail screen wants and no view model carries: who controls the
 * object, and what is holding its deletion open. One reader serves every kind, so a new kind gets
 * them without a schema of its own.
 */
export function getObjectMeta(kind: ManifestKind, name: string, namespace?: string): Promise<ObjectMeta> {
    const op = 'resources.meta';
    return withK8s(op, async () => {
        const object = await findRawObject(kind, name, namespace, op);
        if (!object) throw new K8sError('notFound', `${kind} "${name}" was not found.`, op);
        const meta = object.metadata ?? {};
        const ref = controllerRef(meta);
        const ownerNamespace = meta.namespace ?? '';
        return {
            owner: ref
                ? {
                      apiVersion: ref.apiVersion,
                      kind: ref.kind,
                      name: ref.name,
                      namespace: ownerNamespace,
                      path: ownerPath(ref.apiVersion, ref.kind, ref.name, ownerNamespace),
                  }
                : null,
            finalizers: meta.finalizers ?? [],
            // A deletion timestamp with finalizers still registered is the whole explanation for an
            // object that reads Terminating and stays there.
            deleting: !!meta.deletionTimestamp,
            created: meta.creationTimestamp ? new Date(meta.creationTimestamp).toISOString() : '',
            uid: meta.uid ?? '',
        };
    });
}
