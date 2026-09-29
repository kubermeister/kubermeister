import type { ReleaseRollbackInput, ReleaseWriteResult } from '../../../shared/k8s/addons.js';
import { apis } from '../client.js';
import { K8sError, withK8s } from '../errors.js';
import {
    describeObject,
    goneBetween,
    isKept,
    manifestObjects,
    releaseSecretBody,
    releaseSecrets,
    removeObject,
    restatusRevision,
} from './helm.js';
import { applyConflicts, applyReleaseObject, conflictError, dryRunForRelease, readLive } from './helm-apply.js';
import { DRY_RUN_CONCURRENCY, mapLimited } from './helm-install.js';
import { assertContext } from './write.js';

const ROLLBACK_OP = 'releases.rollback';

/**
 * Roll a release back to one of its own revisions: re-apply that revision's rendered objects, take
 * away what it never had, and record the result as a new revision. Helm numbers forward through a
 * rollback rather than rewinding, and the description says where it came from, so the history reads
 * the same whether the Helm CLI or this app did it.
 *
 * The objects are written by server-side apply, as Helm 4 rolls back and as the upgrade writes them,
 * so a field another manager owns survives the rollback. Every object is dry-run first, so a field
 * the target revision would take from another manager refuses the rollback before anything is written
 * rather than leaving the release half rolled back.
 */
export function rollbackRelease(input: ReleaseRollbackInput): Promise<ReleaseWriteResult> {
    const op = ROLLBACK_OP;
    return withK8s(op, async () => {
        assertContext(input.context, op);
        const revisions = await releaseSecrets(input.name, input.namespace);
        if (revisions.length === 0) {
            throw new K8sError('notFound', `No Helm release "${input.name}" in namespace ${input.namespace}.`, op);
        }
        const current = revisions[0]!;
        const target = revisions.find((one) => one.data.version === input.revision);
        if (!target) {
            throw new K8sError('notFound', `Release "${input.name}" has no revision ${input.revision}.`, op);
        }
        if (target.data.version === current.data.version) {
            throw new K8sError('invalid', `Release "${input.name}" already runs revision ${input.revision}.`, op);
        }

        const wanted = manifestObjects(target.data.manifest, input.namespace);
        const present = manifestObjects(current.data.manifest, input.namespace);
        await mapLimited(wanted, DRY_RUN_CONCURRENCY, async (object) => {
            try {
                await dryRunForRelease(object, input.name, input.namespace, await readLive(object));
            } catch (error) {
                const conflicts = applyConflicts(error);
                if (conflicts) throw conflictError(op, describeObject(object), conflicts);
                throw error;
            }
        });
        for (const object of wanted) await applyReleaseObject(object, input.name, input.namespace, op);

        const removable = goneBetween(present, wanted);
        const kept = removable.filter(isKept);
        for (const object of removable.filter((one) => !isKept(one))) await removeObject(object);

        const revision = (current.data.version ?? 0) + 1;
        await apis().core.createNamespacedSecret({
            namespace: input.namespace,
            body: releaseSecretBody({
                ...target.data,
                version: revision,
                info: {
                    ...target.data.info,
                    status: 'deployed',
                    last_deployed: new Date().toISOString(),
                    description: `Rollback to ${input.revision}`,
                },
                // Applied server-side whatever the target revision was, so a later `helm upgrade` does too.
                apply_method: 'ssa',
            }),
        });
        await restatusRevision(current.secret, current.data, 'superseded');

        return {
            name: input.name,
            namespace: input.namespace,
            revision,
            removed: removable.length - kept.length,
            kept: kept.length,
        };
    });
}
