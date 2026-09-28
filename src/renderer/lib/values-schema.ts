import type { JsonSchema } from '../../shared/chart-values';
import type { FieldShape, PathStep, SchemaLens } from './manifest-completion';

/**
 * Reading a chart's `values.schema.json`, the JSON Schema (draft-07 and later) Helm checks values
 * against before it renders. It is the counterpart of the OpenAPI walk in `manifest-validation.ts`
 * for a different dialect: `$ref` within the file, `allOf`, `anyOf`, `oneOf`, a `type` that may be a
 * list, `true` and `false` as schemas. The file is whatever the chart's author wrote, so no keyword
 * is trusted to have the shape the specification gives it: one that does not is read as absent.
 */

export type SchemaObject = Record<string, unknown>;

/** Deep enough for any schema written by hand, shallow enough that a `$ref` cycle ends. */
export const MAX_DEPTH = 64;

export function asObject(value: unknown): SchemaObject | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as SchemaObject) : null;
}

export function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** The schemas a keyword holds a list of, as `allOf` does; anything else holds none. */
export function subschemas(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

/** The types a schema names, from `type` written as one name or as a list. */
export function typesOf(schema: SchemaObject): string[] {
    return typeof schema.type === 'string' ? [schema.type] : stringList(schema.type);
}

/** The values a schema allows outright, from `enum` or `const`, or undefined when it names none. */
export function allowedValues(schema: SchemaObject): unknown[] | undefined {
    if (Object.hasOwn(schema, 'const')) return [schema.const];
    return Array.isArray(schema.enum) ? schema.enum : undefined;
}

/**
 * Where a `$ref` within the file points: `#` for the root, or a JSON Pointer after it into
 * `definitions`, `$defs` or anywhere else. A reference to another file or an `$anchor` has nothing
 * here to resolve against and answers undefined, which the walk reads as a schema saying nothing.
 */
export function refTarget(root: JsonSchema, ref: unknown): unknown {
    if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
    const pointer = ref.slice(1);
    if (pointer === '') return root;
    if (!pointer.startsWith('/')) return undefined;
    let node: unknown = root;
    for (const raw of pointer.slice(1).split('/')) {
        let token: string;
        try {
            token = decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~');
        } catch {
            return undefined;
        }
        if (Array.isArray(node)) {
            if (!/^\d+$/.test(token)) return undefined;
            node = node[Number(token)];
        } else {
            const object = asObject(node);
            if (!object || !Object.hasOwn(object, token)) return undefined;
            node = object[token];
        }
    }
    return node;
}

/** One schema object met while following a node's references and compositions. */
export interface SchemaPart {
    schema: SchemaObject;
    /** False below an `anyOf` or `oneOf`, whose branches may or may not be the one that applies. */
    certain: boolean;
}

/**
 * Every schema object that speaks about the same value as `nodes`: each one, what its `$ref`
 * points at, and the branches of its `allOf`, `anyOf` and `oneOf`, each met once, so a cycle of
 * references ends where it started.
 */
export function expand(root: JsonSchema, nodes: unknown[]): SchemaPart[] {
    const out: SchemaPart[] = [];
    const seen = new Set<SchemaObject>();
    const visit = (node: unknown, certain: boolean, depth: number) => {
        const schema = asObject(node);
        if (!schema || seen.has(schema) || depth > MAX_DEPTH) return;
        seen.add(schema);
        out.push({ schema, certain });
        if (schema.$ref !== undefined) visit(refTarget(root, schema.$ref), certain, depth + 1);
        for (const part of subschemas(schema.allOf)) visit(part, certain, depth + 1);
        for (const part of [...subschemas(schema.anyOf), ...subschemas(schema.oneOf)]) visit(part, false, depth + 1);
    };
    for (const node of nodes) visit(node, true, 0);
    return out;
}

/** A pattern from the schema, or null for one JavaScript cannot compile, which then matches nothing. */
export function patternOf(source: string): RegExp | null {
    try {
        return new RegExp(source, 'u');
    } catch {
        return null;
    }
}

/**
 * The schemas that speak for the value under `key` of an object `parts` describe: the property of
 * that name, else every `patternProperties` entry matching it, else `additionalProperties`.
 */
export function schemasForKey(parts: SchemaPart[], key: string): unknown[] {
    const out: unknown[] = [];
    for (const { schema } of parts) {
        const properties = asObject(schema.properties);
        if (properties && Object.hasOwn(properties, key)) {
            out.push(properties[key]);
            continue;
        }
        const patterns = Object.entries(asObject(schema.patternProperties) ?? {}).filter(
            ([source]) => patternOf(source)?.test(key) ?? false,
        );
        if (patterns.length > 0) out.push(...patterns.map(([, value]) => value));
        else if (schema.additionalProperties !== undefined) out.push(schema.additionalProperties);
    }
    return out;
}

/** The schemas that speak for the items of a list `parts` describe, whatever their position. */
export function schemasForItems(parts: SchemaPart[]): unknown[] {
    return parts.flatMap(({ schema }) => [
        ...subschemas(schema.prefixItems),
        ...(Array.isArray(schema.items) ? schema.items : schema.items !== undefined ? [schema.items] : []),
    ]);
}

function shapeOf(parts: SchemaPart[]): FieldShape {
    const types = new Set<string>();
    const properties = new Set<string>();
    const required = new Set<string>();
    let description: string | undefined;
    let allowed: unknown[] | undefined;
    for (const { schema, certain } of parts) {
        for (const type of typesOf(schema)) types.add(type);
        for (const key of Object.keys(asObject(schema.properties) ?? {})) properties.add(key);
        if (certain) for (const key of stringList(schema.required)) required.add(key);
        description ??= typeof schema.description === 'string' ? schema.description : undefined;
        allowed ??= allowedValues(schema);
    }
    // A title is what a chart without descriptions writes instead, so it stands in for one.
    description ??= parts.map(({ schema }) => schema.title).find((title) => typeof title === 'string') as
        string | undefined;
    return { types: [...types], description, enum: allowed, required: [...required], properties: [...properties] };
}

/** The schemas at the end of a path from the root, or none where the schema has nothing to say. */
export function schemasAt(root: JsonSchema, path: PathStep[]): unknown[] {
    let nodes: unknown[] = [root];
    for (const step of path) {
        const parts = expand(root, nodes);
        nodes = 'item' in step ? schemasForItems(parts) : schemasForKey(parts, step.key);
        if (nodes.length === 0) return [];
    }
    return nodes;
}

/**
 * A chart's values schema read as a lens, for completion and the description over a value. Where a
 * value may take several forms (`anyOf`, `oneOf`) the lens offers what any of them holds, since it
 * cannot yet know which the value will be; only what every form requires is marked required.
 */
export function valuesLens(root: JsonSchema): SchemaLens {
    return {
        fieldAt(path) {
            const nodes = schemasAt(root, path);
            return nodes.length > 0 ? shapeOf(expand(root, nodes)) : null;
        },
    };
}
