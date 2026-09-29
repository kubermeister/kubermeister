import { z } from 'zod';
import { namespaceNameSchema } from './names.js';
import { KIND_REGISTRY, registeredKindOf } from './registry.js';

/**
 * Who controls an object, and who controls them. A pod's chain reads ReplicaSet then Deployment,
 * a job's reads CronJob, and a pod nothing owns has none at all. The chain is what turns a pod
 * into the workload it belongs to, which is the question every screen around it ends up asking.
 */

export const ownerLinkSchema = z.object({
    /**
     * The owner's `apiVersion` as its reference names it. The kind alone is not an identity: an
     * OpenKruise `StatefulSet` or a Volcano `Job` shares its name with a built-in kind.
     */
    apiVersion: z.string(),
    /** The owner's kind as the API reports it, including kinds the app has no screen for. */
    kind: z.string(),
    name: z.string(),
    namespace: z.string(),
    /** The screen showing this object, or null when the app cannot show that kind yet. */
    path: z.string().nullable(),
});

/** Immediate owner first, then its own owner: ReplicaSet, then the Deployment behind it. */
export const ownerChainSchema = z.array(ownerLinkSchema);

/** Controllers whose pods can be listed: every kind that owns pods, directly or through a Job. */
export const POD_OWNER_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'] as const;
export const podOwnerKindSchema = z.enum(POD_OWNER_KINDS);

export const ownedPodsInputSchema = z.object({
    kind: podOwnerKindSchema,
    name: z.string().min(1),
    namespace: namespaceNameSchema,
});

export type OwnerLink = z.infer<typeof ownerLinkSchema>;
export type OwnerChain = z.infer<typeof ownerChainSchema>;
export type PodOwnerKind = z.infer<typeof podOwnerKindSchema>;
export type OwnedPodsInput = z.infer<typeof ownedPodsInputSchema>;

/** Kinds whose pods a rollout restart replaces; a pod owned by one of these can be restarted. */
export const RESTARTABLE_OWNER_KINDS: readonly string[] = ['Deployment', 'StatefulSet', 'DaemonSet'];

/**
 * The screen for one owner, or null when the app has no list for that kind. Derived from the
 * registry so a new kind's detail route becomes linkable the moment it is registered, and matched on
 * the API group as well as the kind, so a custom resource named like a built-in kind is never linked
 * to the built-in kind's screen.
 */
export function ownerPath(apiVersion: string, kind: string, name: string, namespace: string): string | null {
    const registered = registeredKindOf(apiVersion, kind);
    if (!registered) return null;
    const info = KIND_REGISTRY[registered];
    return info.clusterScoped ? `${info.listPath}/${name}` : `${info.listPath}/${namespace}/${name}`;
}

/** The first owner in the chain a rollout restart would act on, if any. */
export function restartableOwner(chain: OwnerChain): OwnerLink | undefined {
    return chain.find((link) => {
        const registered = registeredKindOf(link.apiVersion, link.kind);
        return !!registered && RESTARTABLE_OWNER_KINDS.includes(registered);
    });
}
