import { z } from 'zod';

/**
 * What the cluster says about the kinds it serves. The API server publishes an OpenAPI v3 document
 * per group-version, so everything the editor can know about a manifest — which fields exist, what
 * they hold, which values are allowed — comes from the cluster rather than from a vocabulary this
 * app compiles in. That is what lets a custom resource be understood as well as a Pod: a CRD's
 * definition publishes a schema like any other kind.
 */

/** The prefix every `$ref` in a Kubernetes OpenAPI v3 document carries. */
const REF_PREFIX = '#/components/schemas/';

/** The definition a `$ref` names, or null when it points somewhere this app does not follow. */
export function refName(ref: string): string | null {
    return ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : null;
}

/** The `$ref` that names a definition, the inverse of {@link refName}. */
export function refTo(name: string): string {
    return `${REF_PREFIX}${name}`;
}

/** The group, version and kind a top-level schema declares it describes. */
export const groupVersionKindSchema = z.object({
    group: z.string(),
    version: z.string(),
    kind: z.string(),
});

export type GroupVersionKind = z.infer<typeof groupVersionKindSchema>;

/**
 * One schema node, kept to the fields validation and completion actually read. Anything else the
 * document carries (examples, patch strategies, the rest of the `x-kubernetes-` family) is dropped
 * on the way in: a group-version document is megabytes, and every field kept is one that crosses
 * the bridge for every kind opened.
 */
export interface SchemaNode {
    $ref?: string;
    type?: string;
    format?: string;
    description?: string;
    default?: unknown;
    enum?: unknown[];
    required?: string[];
    nullable?: boolean;
    properties?: Record<string, SchemaNode>;
    items?: SchemaNode;
    /** A schema for the values of a free-form map, or `false` for a map that allows no keys. */
    additionalProperties?: SchemaNode | boolean;
    allOf?: SchemaNode[];
    oneOf?: SchemaNode[];
    anyOf?: SchemaNode[];
    /** Present on the top-level schema of every kind; how a kind is found in its document. */
    'x-kubernetes-group-version-kind'?: GroupVersionKind[];
    /** A quantity-like field the API server accepts as either, which `type` alone would fail. */
    'x-kubernetes-int-or-string'?: boolean;
    /** A subtree the API server keeps verbatim, so unknown fields under it are not unknown. */
    'x-kubernetes-preserve-unknown-fields'?: boolean;
}

export const schemaNodeSchema: z.ZodType<SchemaNode> = z.lazy(() =>
    z.object({
        $ref: z.string().optional(),
        type: z.string().optional(),
        format: z.string().optional(),
        description: z.string().optional(),
        default: z.unknown().optional(),
        enum: z.array(z.unknown()).optional(),
        required: z.array(z.string()).optional(),
        nullable: z.boolean().optional(),
        properties: z.record(z.string(), schemaNodeSchema).optional(),
        items: schemaNodeSchema.optional(),
        additionalProperties: z.union([z.boolean(), schemaNodeSchema]).optional(),
        allOf: z.array(schemaNodeSchema).optional(),
        oneOf: z.array(schemaNodeSchema).optional(),
        anyOf: z.array(schemaNodeSchema).optional(),
        'x-kubernetes-group-version-kind': z.array(groupVersionKindSchema).optional(),
        'x-kubernetes-int-or-string': z.boolean().optional(),
        'x-kubernetes-preserve-unknown-fields': z.boolean().optional(),
    }),
);

/**
 * A group-version as a manifest writes it: `v1`, or `<group>/<version>`. The value decides which
 * document is looked up, so it is checked at the boundary rather than trusted: one slash at most,
 * and segments that can hold neither a path traversal nor a query string.
 */
export const apiVersionSchema = z
    .string()
    .regex(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*\/)?[a-z0-9]+$/, 'must be a group-version');

export const kindNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/, 'must be a Kubernetes kind name');

export const kindSchemaInputSchema = z.object({ apiVersion: apiVersionSchema, kind: kindNameSchema });

/**
 * A kind's schema and everything it reaches. The kind's own schema is in `definitions` under
 * `name` rather than beside it, so resolving a `$ref` is the same lookup wherever it appears and
 * a recursive kind (a CRD describing schemas, say) carries no copy of itself.
 */
export const kindSchemaSchema = z.object({
    apiVersion: z.string(),
    kind: z.string(),
    /** The document it was read from, as `/openapi/v3` names it, e.g. `apis/apps/v1`. */
    document: z.string(),
    /** The kind's own definition name, e.g. `io.k8s.api.apps.v1.Deployment`. */
    name: z.string(),
    /** The kind's schema and every one reachable from it through `$ref`, keyed by definition name. */
    definitions: z.record(z.string(), schemaNodeSchema),
});

export type KindSchemaInput = z.infer<typeof kindSchemaInputSchema>;
export type KindSchema = z.infer<typeof kindSchemaSchema>;
