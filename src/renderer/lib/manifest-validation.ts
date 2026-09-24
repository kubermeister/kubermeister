import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, type Document, type Node, type Scalar } from 'yaml';
import {
    kindSchemaInputSchema,
    refName,
    type KindSchema,
    type KindSchemaInput,
    type SchemaNode,
} from '../../shared/k8s/openapi';

/**
 * Checks a manifest in the editor against the schema the cluster publishes for its kind, without a
 * DOM or a cluster, so the whole of it is tested on fixture schemas. The same rules main applies
 * before a write are checked here too, so what the editor marks is what applying would refuse,
 * placed where it is wrong rather than reported after the fact.
 */

export interface ManifestDiagnostic {
    from: number;
    to: number;
    /** An error is something applying refuses; a warning is something the API server ignores. */
    severity: 'error' | 'warning';
    message: string;
}

export interface ReadManifest {
    /** The single document, when there is one to check against a schema. */
    doc: Document.Parsed | null;
    /** What the manifest says it is, when it says so in a form the schema lookup accepts. */
    head: KindSchemaInput | null;
    /** Syntax errors and the ones main refuses a manifest for before the cluster sees it. */
    diagnostics: ManifestDiagnostic[];
}

type Range = readonly [number, number];

function rangeOf(node: Node | null | undefined, fallback: Range): Range {
    return node?.range ? [node.range[0], node.range[1]] : fallback;
}

function firstLine(message: string): string {
    return message.split('\n')[0]?.trim() ?? message;
}

function stringKey(node: unknown): string | null {
    return isScalar(node) && typeof node.value === 'string' ? node.value : null;
}

function mapValue(map: Node | null, key: string): Node | null {
    if (!isMap(map)) return null;
    const pair = map.items.find((item) => stringKey(item.key) === key);
    return (pair?.value as Node | null | undefined) ?? null;
}

function mapKey(map: Node | null, key: string): Node | null {
    if (!isMap(map)) return null;
    return (map.items.find((item) => stringKey(item.key) === key)?.key as Node | undefined) ?? null;
}

function scalarString(node: Node | null): string | null {
    return isScalar(node) && typeof node.value === 'string' && node.value !== '' ? node.value : null;
}

/**
 * Parse the editor's text and check what main checks before any write: one document, an object,
 * with `apiVersion`, `kind` and a name. Empty text is no manifest yet rather than a wrong one.
 */
export function readManifest(text: string): ReadManifest {
    const diagnostics: ManifestDiagnostic[] = [];
    if (text.trim() === '') return { doc: null, head: null, diagnostics };
    const whole: Range = [0, text.length];
    const docs = parseAllDocuments(text, { prettyErrors: false });
    const all = Array.isArray(docs) ? docs : [];
    for (const doc of all) {
        for (const error of doc.errors) {
            diagnostics.push({
                from: error.pos[0],
                to: Math.max(error.pos[1], error.pos[0] + 1),
                severity: 'error',
                message: firstLine(error.message),
            });
        }
    }
    const extra = all[1];
    if (extra) {
        const at = rangeOf(extra.contents, whole);
        diagnostics.push({
            from: at[0],
            to: at[1],
            severity: 'error',
            message: 'A manifest here is a single object; apply the next document on its own.',
        });
    }
    const doc = all[0];
    // Text mid-edit rarely parses, and that is when completion is wanted: the kind is still read
    // from a document whose top is a mapping, while the schema check waits for YAML that parses.
    if (!doc || diagnostics.length > 0) return { doc: null, head: doc ? headOf(doc.contents) : null, diagnostics };
    const root = doc.contents;
    if (!isMap(root)) {
        const at = rangeOf(root, whole);
        diagnostics.push({ from: at[0], to: at[1], severity: 'error', message: 'The manifest must be a YAML object.' });
        return { doc: null, head: null, diagnostics };
    }
    const top = rangeOf(root.items[0]?.key as Node | undefined, whole);
    const apiVersion = scalarString(mapValue(root, 'apiVersion'));
    const kind = scalarString(mapValue(root, 'kind'));
    if (!apiVersion || !kind) {
        diagnostics.push({
            from: top[0],
            to: top[1],
            severity: 'error',
            message: 'The manifest must declare apiVersion and kind.',
        });
    }
    const metadata = mapValue(root, 'metadata');
    if (!scalarString(mapValue(metadata, 'name')) && !scalarString(mapValue(metadata, 'generateName'))) {
        const at = rangeOf(mapKey(root, 'metadata'), top);
        diagnostics.push({
            from: at[0],
            to: at[1],
            severity: 'error',
            message: 'The manifest must declare metadata.name.',
        });
    }
    return { doc, head: headOf(root), diagnostics };
}

/** The kind a document's top mapping names, in a form the schema lookup accepts, or null. */
function headOf(root: Node | null): KindSchemaInput | null {
    const head = kindSchemaInputSchema.safeParse({
        apiVersion: scalarString(mapValue(root, 'apiVersion')),
        kind: scalarString(mapValue(root, 'kind')),
    });
    return head.success ? head.data : null;
}

/** A schema node with its `$ref` followed and its `allOf` folded in, which is how the API server reads it. */
export interface Resolved {
    types: string[];
    description?: string;
    enum?: unknown[];
    required: string[];
    properties: Record<string, SchemaNode>;
    hasProperties: boolean;
    additionalProperties?: SchemaNode | boolean;
    items?: SchemaNode;
    preserveUnknown: boolean;
}

const MAX_DEPTH = 64;

/**
 * Definitions whose published type is narrower than what the API server decodes. Older servers
 * publish both as a plain string, yet `cpu: 1` and `targetPort: 8080` are what everyone writes and
 * what the server accepts, so a number is allowed for them whatever the document says.
 */
const LENIENT_DEFINITIONS: Record<string, string[]> = {
    'io.k8s.apimachinery.pkg.api.resource.Quantity': ['string', 'number'],
    'io.k8s.apimachinery.pkg.util.intstr.IntOrString': ['integer', 'string'],
};

export function resolve(node: SchemaNode | undefined, definitions: KindSchema['definitions'], depth = 0): Resolved {
    const out: Resolved = { types: [], required: [], properties: {}, hasProperties: false, preserveUnknown: false };
    if (!node || depth > MAX_DEPTH) return out;
    const targetName = node.$ref ? refName(node.$ref) : null;
    const lenient = targetName ? LENIENT_DEFINITIONS[targetName] : undefined;
    if (lenient) return { ...out, types: lenient, description: definitions[targetName ?? '']?.description };
    const target = targetName ? definitions[targetName] : undefined;
    const parts = [node, ...(target ? [target] : []), ...(node.allOf ?? [])];
    for (const part of parts) {
        const inner = part === node ? null : resolve(part, definitions, depth + 1);
        const source = inner ?? {
            types:
                part['x-kubernetes-int-or-string'] || part.format === 'int-or-string'
                    ? ['integer', 'string']
                    : part.type
                      ? [part.type]
                      : alternatives(part, definitions, depth),
            description: part.description,
            enum: part.enum,
            required: part.required ?? [],
            properties: part.properties ?? {},
            hasProperties: part.properties !== undefined && Object.keys(part.properties).length > 0,
            additionalProperties: part.additionalProperties,
            items: part.items,
            preserveUnknown: part['x-kubernetes-preserve-unknown-fields'] === true,
        };
        if (out.types.length === 0) out.types = source.types;
        out.description ??= source.description;
        out.enum ??= source.enum;
        out.required = [...out.required, ...source.required];
        out.properties = { ...source.properties, ...out.properties };
        out.hasProperties ||= source.hasProperties;
        out.additionalProperties ??= source.additionalProperties;
        out.items ??= source.items;
        out.preserveUnknown ||= source.preserveUnknown;
    }
    return out;
}

/** The types a `oneOf` or `anyOf` allows, which is how a Quantity says "a string or a number". */
function alternatives(node: SchemaNode, definitions: KindSchema['definitions'], depth: number): string[] {
    const branches = [...(node.oneOf ?? []), ...(node.anyOf ?? [])].map(
        (branch) => resolve(branch, definitions, depth + 1).types,
    );
    // A branch that says nothing about type allows any, so the union does too.
    if (branches.length === 0 || branches.some((types) => types.length === 0)) return [];
    return [...new Set(branches.flat())];
}

function actualType(node: Node): string | null {
    if (isMap(node)) return 'object';
    if (isSeq(node)) return 'array';
    if (!isScalar(node)) return null;
    const value = (node as Scalar).value;
    if (value === null) return 'null';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    if (typeof value === 'bigint') return 'integer';
    if (typeof value === 'string') return 'string';
    if (typeof value === 'boolean') return 'boolean';
    return null;
}

const TYPE_WORDS: Record<string, string> = {
    object: 'an object',
    array: 'a list',
    string: 'a string',
    integer: 'a whole number',
    number: 'a number',
    boolean: 'true or false',
};

function typeMatches(expected: string[], actual: string): boolean {
    if (expected.length === 0) return true;
    return expected.includes(actual) || (actual === 'integer' && expected.includes('number'));
}

export function describeTypes(types: string[]): string {
    return types.map((type) => TYPE_WORDS[type] ?? type).join(' or ');
}

/** Edit distance, for naming the field a misspelt one was probably meant to be. */
function distance(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        let previous = row[0]!;
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const current = row[j]!;
            row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = current;
        }
    }
    return row[b.length]!;
}

function suggestion(key: string, known: string[]): string | null {
    const lower = key.toLowerCase();
    const exact = known.find((candidate) => candidate.toLowerCase() === lower);
    if (exact) return exact;
    let best: { name: string; score: number } | null = null;
    for (const candidate of known) {
        const score = distance(lower, candidate.toLowerCase());
        if (score <= Math.max(1, Math.floor(candidate.length / 4)) && (!best || score < best.score)) {
            best = { name: candidate, score };
        }
    }
    return best?.name ?? null;
}

function check(
    node: Node | null,
    schema: SchemaNode | undefined,
    anchor: Range,
    definitions: KindSchema['definitions'],
    out: ManifestDiagnostic[],
    depth: number,
): void {
    // An alias points at a node checked where it was defined; null is how YAML leaves a field unset.
    if (!node || isAlias(node) || depth > MAX_DEPTH) return;
    const resolved = resolve(schema, definitions);
    const actual = actualType(node);
    if (actual === null || actual === 'null') return;
    const at = rangeOf(node, anchor);
    if (!typeMatches(resolved.types, actual)) {
        const quoted =
            resolved.types.includes('string') && (actual === 'integer' || actual === 'number' || actual === 'boolean');
        out.push({
            from: at[0],
            to: at[1],
            severity: 'error',
            message: `Expected ${describeTypes(resolved.types)}, found ${TYPE_WORDS[actual] ?? actual}.${quoted ? ' Quote the value to keep it a string.' : ''}`,
        });
        return;
    }
    if (resolved.enum && isScalar(node) && !resolved.enum.includes(node.value)) {
        out.push({
            from: at[0],
            to: at[1],
            severity: 'error',
            message: `Must be one of ${resolved.enum.map((value) => JSON.stringify(value)).join(', ')}.`,
        });
    }
    if (isMap(node)) {
        const known = Object.keys(resolved.properties);
        const present = new Set<string>();
        for (const pair of node.items) {
            const key = stringKey(pair.key);
            if (key === null) continue;
            present.add(key);
            const keyRange = rangeOf(pair.key as Node, at);
            const value = pair.value as Node | null;
            const property = resolved.properties[key];
            if (property) {
                check(value, property, keyRange, definitions, out, depth + 1);
            } else if (typeof resolved.additionalProperties === 'object') {
                check(value, resolved.additionalProperties, keyRange, definitions, out, depth + 1);
            } else if (resolved.hasProperties && resolved.additionalProperties !== true && !resolved.preserveUnknown) {
                const near = suggestion(key, known);
                out.push({
                    from: keyRange[0],
                    to: keyRange[1],
                    severity: 'warning',
                    message: `"${key}" is not a field here, so the API server ignores it.${near ? ` Did you mean "${near}"?` : ''}`,
                });
            }
        }
        const missing = [...new Set(resolved.required)].filter((key) => !present.has(key));
        if (missing.length > 0) {
            out.push({
                from: anchor[0],
                to: anchor[1],
                severity: 'error',
                message: `Missing required ${missing.length === 1 ? 'field' : 'fields'} ${missing.map((key) => `"${key}"`).join(', ')}.`,
            });
        }
    } else if (isSeq(node) && resolved.items) {
        for (const item of node.items) {
            const itemNode = item as Node | null;
            // An item's own problems are marked on its first line, not across every line it spans.
            const first = isMap(itemNode) ? (itemNode.items[0]?.key as Node | undefined) : itemNode;
            check(itemNode, resolved.items, rangeOf(first, at), definitions, out, depth + 1);
        }
    }
}

/** Every place the document departs from its kind's schema. */
export function validateAgainstSchema(doc: Document.Parsed, schema: KindSchema): ManifestDiagnostic[] {
    const out: ManifestDiagnostic[] = [];
    const root = doc.contents;
    const anchor = rangeOf(isMap(root) ? (root.items[0]?.key as Node | undefined) : root, [0, 0]);
    check(root, schema.definitions[schema.name], anchor, schema.definitions, out, 0);
    // In the order a reader meets them, top to bottom, rather than the order the walk found them.
    return out.sort((a, b) => a.from - b.from);
}

/**
 * The whole check over a manifest already read: what main refuses, then, with the schema of the
 * very kind it names to hand, what that schema says. A schema for any other kind is no schema,
 * which is what it is while the lookup for a kind just typed is still on its way.
 */
export function diagnose(read: ReadManifest, schema: KindSchema | null | undefined): ManifestDiagnostic[] {
    const matching = schema && read.head?.apiVersion === schema.apiVersion && read.head.kind === schema.kind;
    return matching && read.doc ? [...read.diagnostics, ...validateAgainstSchema(read.doc, schema)] : read.diagnostics;
}

export function validateManifest(text: string, schema: KindSchema | null): ManifestDiagnostic[] {
    return diagnose(readManifest(text), schema);
}
