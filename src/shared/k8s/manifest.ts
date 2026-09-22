import { z } from 'zod';
import { namespaceNameSchema } from './names.js';
import { KIND_REGISTRY, KINDS } from './registry.js';

/**
 * Kinds whose live manifest can be read. Nodes and namespaces are not in the kind registry (they
 * have bespoke channels of their own) but their details show a manifest like every other object,
 * and a namespace is created and deleted through the same write path, so the vocabulary is the
 * registry's kinds plus those two.
 */
export const manifestKindSchema = z.enum([...KINDS, 'Node', 'Namespace']);

export type ManifestKind = z.infer<typeof manifestKindSchema>;

/** Whether a kind string names a kind whose object can be read through the manifest channels. */
export function isManifestKind(kind: string | undefined): kind is ManifestKind {
    return !!kind && manifestKindSchema.safeParse(kind).success;
}

export function isClusterScopedManifestKind(kind: ManifestKind): boolean {
    return kind === 'Node' || kind === 'Namespace' || KIND_REGISTRY[kind].clusterScoped;
}

/**
 * Kinds whose deletion reaches far beyond the object itself: a node takes its workloads, a CRD
 * takes every custom resource of its type, the rest are cluster-wide plumbing. Their delete asks
 * the user to type the name, and they are kept out of bulk delete.
 */
export const DANGEROUS_KINDS: ReadonlySet<ManifestKind> = new Set<ManifestKind>([
    'Node',
    // Deleting a namespace takes every object inside it, which is the furthest-reaching delete here.
    'Namespace',
    'CustomResourceDefinition',
    'PersistentVolume',
    'StorageClass',
    'ClusterRole',
    'ClusterRoleBinding',
]);

/**
 * A namespaced kind must name its namespace and a cluster-scoped kind must not. Applied to every
 * per-object input so a caller can neither omit the namespace (which would fall back to whatever
 * is active) nor attach one where it means nothing.
 */
export function refineManifestTarget(target: { kind: ManifestKind; namespace?: string }, ctx: z.RefinementCtx): void {
    const clusterScoped = isClusterScopedManifestKind(target.kind);
    if (!clusterScoped && target.namespace === undefined) {
        ctx.addIssue({ code: 'custom', path: ['namespace'], message: `${target.kind} requires a namespace` });
    }
    if (clusterScoped && target.namespace !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['namespace'], message: `${target.kind} is cluster-scoped` });
    }
}

export const manifestInputSchema = z
    .object({
        kind: manifestKindSchema,
        name: z.string().min(1),
        namespace: namespaceNameSchema.optional(),
    })
    .superRefine(refineManifestTarget);

export const manifestSchema = z.object({
    yaml: z.string(),
    kind: z.string(),
    namespace: z.string().optional(),
});

export type ManifestInput = z.infer<typeof manifestInputSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

/** One object a list selection names; the namespace follows the kind's scope, as every target does. */
const exportTargetSchema = z.object({
    name: z.string().min(1),
    namespace: namespaceNameSchema.optional(),
});

/**
 * A list selection saved to one YAML file. `clean` asks for the objects as somebody would write
 * them rather than as the API server hands them back, which is what makes the file applicable to
 * another cluster.
 */
export const manifestExportInputSchema = z
    .object({
        kind: manifestKindSchema,
        targets: z.array(exportTargetSchema).min(1),
        clean: z.boolean(),
    })
    .superRefine((input, ctx) => {
        const clusterScoped = isClusterScopedManifestKind(input.kind);
        input.targets.forEach((target, index) => {
            const named = target.namespace !== undefined;
            if (clusterScoped === named) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['targets', index, 'namespace'],
                    message: named ? `${input.kind} is cluster-scoped` : `${input.kind} requires a namespace`,
                });
            }
        });
    });

export const manifestExportSchema = z.object({
    /** Where the file was written, or null when the save dialog was dismissed. */
    path: z.string().nullable(),
    /** How many objects the file holds: fewer than were selected when one has since been deleted. */
    count: z.number().int().min(0),
});

export type ManifestExportTarget = z.infer<typeof exportTargetSchema>;
export type ManifestExportInput = z.infer<typeof manifestExportInputSchema>;
export type ManifestExport = z.infer<typeof manifestExportSchema>;
