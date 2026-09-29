import { Document, isAlias, isMap, isScalar, isSeq, parse, parseAllDocuments, type Node } from 'yaml';
import type { JsonValue } from '../../shared/chart-install';
import type { JsonSchema } from '../../shared/chart-values';
import {
    actualType,
    describeTypes,
    firstLine,
    rangeOf,
    stringKey,
    suggestion,
    typeMatches,
    type ManifestDiagnostic,
    type Range,
} from './manifest-validation';
import {
    MAX_DEPTH,
    allowedValues,
    asObject,
    expand,
    patternOf,
    refTarget,
    schemasForItems,
    schemasForKey,
    stringList,
    subschemas,
    typesOf,
} from './values-schema';

/**
 * Checks a chart's values in the editor against the chart's `values.schema.json`, placing each
 * problem on the value it is about, so what Helm would refuse at render time is marked while the
 * values are written. Pure, and tested on fixture schemas.
 *
 * Helm checks the values it renders with, which are the edited ones merged over the chart's own
 * `values.yaml`: a key left out keeps its default and a key set to null deletes it. So a required
 * value counts as present when the chart's defaults supply it, and missing when it is nulled out.
 * The keywords checked are the ones that say what a value is — `type`, `enum`, `const`, `required`,
 * `properties`, `additionalProperties`, `patternProperties`, `items` — through `$ref`, `allOf`,
 * `anyOf` and `oneOf`. The rest (`pattern`, `minimum`, formats) Helm checks when it renders, and its
 * message lands on the value through `values-render-error.ts`.
 *
 * The text is read as YAML 1.2, the way main reads every manifest, so `yes` is a string here.
 */

export interface ReadValues {
    /** The single document, when it parses; its contents are null for a file of comments only. */
    doc: Document.Parsed | null;
    /** Syntax errors, and values Helm could not read at all. */
    diagnostics: ManifestDiagnostic[];
}

/** Parse the editor's text as a values file: one document, a mapping, or nothing at all. */
export function readValues(text: string): ReadValues {
    const diagnostics: ManifestDiagnostic[] = [];
    if (text.trim() === '') return { doc: null, diagnostics };
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
            message: 'Values are a single YAML document; Helm reads only the first.',
        });
    }
    const doc = all[0];
    if (!doc || diagnostics.length > 0) return { doc: null, diagnostics };
    const root = doc.contents;
    if (root !== null && !isMap(root) && !(isScalar(root) && root.value === null)) {
        const at = rangeOf(root, whole);
        diagnostics.push({
            from: at[0],
            to: at[1],
            severity: 'error',
            message: 'Values are a YAML mapping of keys to values.',
        });
        return { doc: null, diagnostics };
    }
    return { doc, diagnostics };
}

/** The values Helm is handed, or why the text cannot be handed over. */
export type RenderValues = { values: Record<string, JsonValue> } | { problem: string };

function asJson(value: unknown): JsonValue | undefined {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (Array.isArray(value)) {
        const items = value.map(asJson);
        return items.includes(undefined) ? undefined : (items as JsonValue[]);
    }
    const object = asObject(value);
    if (!object) return undefined;
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(object)) {
        const json = asJson(item);
        if (json === undefined) return undefined;
        out[key] = json;
    }
    return out;
}

/**
 * The editor's text as values. It is read here exactly as it is checked — YAML 1.2, so `yes` is the
 * string it looks like and `010` is ten — and handed to Helm as JSON, which Helm reads with no
 * YAML 1.1 second opinion, so a value the user wrote renders as the editor showed it. Text that does
 * not read, or a number JSON cannot carry, is not handed over.
 */
export function valuesForRender(text: string): RenderValues {
    const { doc, diagnostics } = readValues(text);
    const first = diagnostics[0];
    if (first) return { problem: `The values are not YAML Helm can read: ${first.message}` };
    if (!doc) return { values: {} };
    let parsed: unknown;
    try {
        parsed = doc.toJS({ maxAliasCount: 100 });
    } catch (error) {
        return { problem: `The values are not YAML Helm can read: ${firstLine((error as Error).message)}` };
    }
    if (parsed === null || parsed === undefined) return { values: {} };
    const json = asJson(parsed);
    const values = asObject(json);
    return values
        ? { values: values as Record<string, JsonValue> }
        : { problem: 'The values hold a number JSON cannot carry, such as .inf or .nan.' };
}

/**
 * What Helm is handed for the edited values: only where they differ from the chart's own
 * `values.yaml`, which Helm then reads itself, as YAML 1.1 like `helm install -f` would, so a default
 * written `yes` is true in the release. Both sides are read here as the editor reads them, so a value
 * left as the chart wrote it compares equal and is left out, a mapping is walked into, and anything
 * else that differs (a list, a value of another shape, a null deleting a default) goes over whole. A
 * key taken out of the text keeps its default, as the editor checks it. Defaults that do not read
 * leave nothing to compare with, so every value goes over.
 */
export function valueOverrides(values: Record<string, JsonValue>, defaultsYaml: string): Record<string, JsonValue> {
    const defaults = valuesForRender(defaultsYaml);
    return 'values' in defaults ? changedFrom(values, defaults.values) : values;
}

/**
 * The edited values carried over to another chart version: what the text changed against the
 * defaults it was edited from, written over the other version's `values.yaml`, so a default the user
 * never touched takes the new version's value rather than being pinned to the old one's. The new
 * file keeps its comments and layout; a mapping is walked into, anything else replaces its key
 * whole, as `valueOverrides` hands it over. Null when the text or either file does not read, since
 * there is then no edit to tell apart from the defaults it was made on.
 */
export function rebaseValues(text: string, fromDefaults: string, toDefaults: string): string | null {
    const parsed = valuesForRender(text);
    const from = valuesForRender(fromDefaults);
    if ('problem' in parsed || 'problem' in from) return null;
    const { doc, diagnostics } = readValues(toDefaults);
    if (diagnostics.length > 0) return null;
    // A file of comments only has no mapping to write into, so the edit starts one of its own.
    const target: Document = doc && isMap(doc.contents) ? doc : new Document({});
    writeOver(target, [], changedFrom(parsed.values, from.values));
    return target.toString();
}

function writeOver(doc: Document, path: string[], overrides: Record<string, JsonValue>) {
    for (const [key, value] of Object.entries(overrides)) {
        const at = [...path, key];
        const inner = asObject(value);
        if (inner && isMap(doc.getIn(at, true))) writeOver(doc, at, inner as Record<string, JsonValue>);
        else doc.setIn(at, value);
    }
}

function changedFrom(
    values: Record<string, JsonValue>,
    defaults: Record<string, JsonValue>,
): Record<string, JsonValue> {
    const out: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(values)) {
        if (!Object.hasOwn(defaults, key)) {
            out[key] = value;
            continue;
        }
        const fallback = defaults[key];
        const [inner, innerDefault] = [asObject(value), asObject(fallback)];
        if (inner && innerDefault) {
            const changed = changedFrom(inner as Record<string, JsonValue>, innerDefault as Record<string, JsonValue>);
            if (Object.keys(changed).length > 0) out[key] = changed;
        } else if (canonical(value) !== canonical(fallback)) {
            out[key] = value;
        }
    }
    return out;
}

/** The chart's own values as the merge starts from them; a file that does not read is none. */
export function chartDefaults(valuesYaml: string): Record<string, unknown> {
    try {
        return asObject(parse(valuesYaml)) ?? {};
    } catch {
        return {};
    }
}

interface Walk {
    root: JsonSchema;
    out: ManifestDiagnostic[];
}

function push(walk: Walk, at: Range, message: string, severity: ManifestDiagnostic['severity'] = 'error') {
    walk.out.push({ from: at[0], to: at[1], severity, message });
}

function isUnset(node: Node | null | undefined): boolean {
    return !node || (isScalar(node) && node.value === null);
}

/** JSON with its keys in order, so two values compare equal however their mappings were written. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const object = asObject(value);
    if (object) {
        const keys = Object.keys(object).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

function valueOf(node: Node): unknown {
    return isScalar(node) ? node.value : (node as unknown as { toJSON(): unknown }).toJSON();
}

function missingMessage(missing: string[]): string {
    return `Missing required ${missing.length === 1 ? 'value' : 'values'} ${missing.map((key) => `"${key}"`).join(', ')}.`;
}

/**
 * The required keys a mapping lacks once Helm has merged it over the chart's defaults: absent from
 * both, or nulled out in the edit.
 */
function missingKeys(required: string[], present: Map<string, Node | null>, defaults: unknown): string[] {
    const fallback = asObject(defaults) ?? {};
    return [...new Set(required)].filter((key) =>
        present.has(key) ? isUnset(present.get(key)) : fallback[key] === undefined || fallback[key] === null,
    );
}

/** The types every form of a value names, or none when any form leaves the type open. */
function declaredTypes(walk: Walk, schema: unknown): string[] {
    const parts = expand(walk.root, [schema]).filter((part) => part.certain);
    return [...new Set(parts.flatMap((part) => typesOf(part.schema)))];
}

/**
 * A value that must match one of several forms. Matching any is enough, for `oneOf` too: the walk
 * checks only some keywords, so two forms it cannot tell apart may well be told apart by Helm, and
 * calling that ambiguous would be a mistake of the walk's own. When none matches, the complaint of
 * the one form the value's type fits is the useful one; otherwise the forms are named.
 */
function checkForms(node: Node, forms: unknown[], anchor: Range, defaults: unknown, walk: Walk, depth: number) {
    const results = forms.map((form) => {
        const trial: Walk = { root: walk.root, out: [] };
        check(node, form, anchor, defaults, trial, depth);
        return trial.out;
    });
    if (results.some((out) => out.length === 0)) return;
    const actual = actualType(node) ?? '';
    const types = forms.map((form) => declaredTypes(walk, form));
    const fitting = types.flatMap((declared, index) => (typeMatches(declared, actual) ? [index] : []));
    if (fitting.length === 1) {
        walk.out.push(...results[fitting[0]!]!);
        return;
    }
    const named = types.every((declared) => declared.length > 0) ? [...new Set(types.flat())] : [];
    push(
        walk,
        rangeOf(node, anchor),
        `Matches none of the forms allowed here${named.length > 0 ? `: ${describeTypes(named)}` : ''}.`,
    );
}

function checkMap(
    node: Node,
    schema: Record<string, unknown>,
    at: Range,
    anchor: Range,
    defaults: unknown,
    walk: Walk,
    depth: number,
) {
    if (!isMap(node)) return;
    const fallback = asObject(defaults) ?? {};
    const properties = asObject(schema.properties);
    const patterns = Object.entries(asObject(schema.patternProperties) ?? {});
    const present = new Map<string, Node | null>();
    for (const pair of node.items) {
        const key = stringKey(pair.key);
        if (key === null) continue;
        const value = (pair.value as Node | null | undefined) ?? null;
        present.set(key, value);
        const keyRange = rangeOf(pair.key as Node, at);
        if (properties && Object.hasOwn(properties, key)) {
            check(value, properties[key], keyRange, fallback[key], walk, depth + 1);
            continue;
        }
        const matching = patterns.filter(([source]) => patternOf(source)?.test(key) ?? false);
        for (const [, pattern] of matching) check(value, pattern, keyRange, fallback[key], walk, depth + 1);
        if (matching.length > 0) continue;
        if (schema.additionalProperties === false) {
            const near = suggestion(key, Object.keys(properties ?? {}));
            push(walk, keyRange, `"${key}" is not allowed here.${near ? ` Did you mean "${near}"?` : ''}`);
        } else if (schema.additionalProperties !== undefined) {
            check(value, schema.additionalProperties, keyRange, fallback[key], walk, depth + 1);
        }
    }
    const missing = missingKeys(stringList(schema.required), present, defaults);
    if (missing.length > 0) push(walk, anchor, missingMessage(missing));
}

function checkList(node: Node, schema: Record<string, unknown>, at: Range, walk: Walk, depth: number) {
    if (!isSeq(node)) return;
    // Draft-07 writes a tuple as an `items` list and the rest as `additionalItems`; 2020-12 writes
    // it as `prefixItems` and the rest as `items`.
    const tuple = Array.isArray(schema.prefixItems) ? schema.prefixItems : subschemas(schema.items);
    const rest = Array.isArray(schema.prefixItems)
        ? schema.items
        : Array.isArray(schema.items)
          ? schema.additionalItems
          : schema.items;
    node.items.forEach((item, index) => {
        const itemNode = item as Node | null;
        const itemSchema = index < tuple.length ? tuple[index] : rest;
        if (itemSchema === undefined) return;
        // An item's own problems are marked on its first line, not across every line it spans.
        const first = isMap(itemNode) ? (itemNode.items[0]?.key as Node | undefined) : itemNode;
        // A list replaces the chart's default list whole, so no item has a default of its own.
        check(itemNode, itemSchema, rangeOf(first, at), undefined, walk, depth + 1);
    });
}

/**
 * Check one value against one schema. `anchor` is where the value's key sits, which is where a
 * problem with the value as a whole (a required key it lacks) is marked; `defaults` is what the
 * chart's own values hold at the same place.
 */
function check(node: Node | null, schema: unknown, anchor: Range, defaults: unknown, walk: Walk, depth: number) {
    // An alias points at a value checked where it was defined; null leaves the value to the chart.
    if (!node || isAlias(node) || depth > MAX_DEPTH) return;
    const actual = actualType(node);
    if (actual === null || actual === 'null') return;
    const at = rangeOf(node, anchor);
    if (schema === false) {
        push(walk, at, 'The chart’s schema allows no value here.');
        return;
    }
    const object = asObject(schema);
    if (!object) return;
    const types = typesOf(object);
    if (types.length > 0 && !typeMatches(types, actual)) {
        const quoted =
            types.includes('string') && (actual === 'integer' || actual === 'number' || actual === 'boolean');
        push(
            walk,
            at,
            `Expected ${describeTypes(types)}, found ${describeTypes([actual])}.${quoted ? ' Quote the value to keep it a string.' : ''}`,
        );
        return;
    }
    if (object.$ref !== undefined) check(node, refTarget(walk.root, object.$ref), anchor, defaults, walk, depth + 1);
    for (const part of subschemas(object.allOf)) check(node, part, anchor, defaults, walk, depth + 1);
    for (const forms of [subschemas(object.anyOf), subschemas(object.oneOf)]) {
        if (forms.length > 0) checkForms(node, forms, anchor, defaults, walk, depth + 1);
    }
    const allowed = allowedValues(object);
    if (allowed && !allowed.some((value) => canonical(value) === canonical(valueOf(node)))) {
        push(
            walk,
            at,
            allowed.length === 1
                ? `Must be ${JSON.stringify(allowed[0])}.`
                : `Must be one of ${allowed.map((value) => JSON.stringify(value)).join(', ')}.`,
        );
    }
    checkMap(node, object, at, anchor, defaults, walk, depth);
    checkList(node, object, at, walk, depth);
}

/**
 * Warn about a key that neither the schema nor the chart's own values name, which Helm passes to
 * the templates and they never read: usually a misspelling. Only where the schema lists an object's
 * keys and leaves no others open, and never for `global` or a subchart's section at the top, which
 * belong to Helm and to charts whose schemas are not this one.
 */
function warnUnknown(
    node: Node | null,
    schemas: unknown[],
    defaults: unknown,
    walk: Walk,
    depth: number,
    passThrough: Set<string>,
) {
    if (!node || isAlias(node) || depth > MAX_DEPTH) return;
    const parts = expand(walk.root, schemas);
    if (isSeq(node)) {
        const items = schemasForItems(parts);
        if (items.length > 0)
            for (const item of node.items) warnUnknown(item as Node, items, undefined, walk, depth + 1, passThrough);
        return;
    }
    if (!isMap(node)) return;
    const fallback = asObject(defaults) ?? {};
    const known = new Set(parts.flatMap(({ schema }) => Object.keys(asObject(schema.properties) ?? {})));
    const open =
        parts.length === 0 ||
        parts.some(({ schema }) => schema.additionalProperties !== undefined || schema.patternProperties !== undefined);
    for (const pair of node.items) {
        const key = stringKey(pair.key);
        if (key === null) continue;
        const passes = depth === 0 && passThrough.has(key);
        if (!open && !passes && known.size > 0 && !known.has(key) && !Object.hasOwn(fallback, key)) {
            const near = suggestion(key, [...known]);
            push(
                walk,
                rangeOf(pair.key as Node, [0, 0]),
                `"${key}" is not a value this chart names.${near ? ` Did you mean "${near}"?` : ''}`,
                'warning',
            );
        }
        const inner = schemasForKey(parts, key);
        if (inner.length > 0) warnUnknown(pair.value as Node, inner, fallback[key], walk, depth + 1, passThrough);
    }
}

/**
 * Every place the values depart from the chart's schema, over values already read. `defaults` is
 * the chart's own `values.yaml` read by `chartDefaults`, and `subcharts` the top-level keys that
 * hold a dependency's values.
 */
export function diagnoseValues(
    read: ReadValues,
    schema: JsonSchema | null,
    defaults: unknown,
    subcharts: string[] = [],
): ManifestDiagnostic[] {
    if (schema === null || read.diagnostics.length > 0) return read.diagnostics;
    const walk: Walk = { root: schema, out: [] };
    const root = read.doc?.contents ?? null;
    const anchor = rangeOf(isMap(root) ? (root.items[0]?.key as Node | undefined) : null, [0, 0]);
    if (isMap(root)) {
        check(root, schema, anchor, defaults, walk, 0);
    } else {
        // No values at all: the chart's defaults are the values, and only what they lack is missing.
        const required = expand(schema, [schema]).flatMap((part) =>
            part.certain ? stringList(part.schema.required) : [],
        );
        const missing = missingKeys(required, new Map(), defaults);
        if (missing.length > 0) push(walk, anchor, missingMessage(missing));
    }
    warnUnknown(root, [schema], defaults, walk, 0, new Set(['global', ...subcharts]));
    // A problem two parts of the schema both find is one problem; in reading order, top to bottom.
    const unique = new Map(walk.out.map((mark) => [`${mark.from}:${mark.to}:${mark.message}`, mark]));
    return [...unique.values()].sort((a, b) => a.from - b.from);
}

export function validateValues(
    text: string,
    schema: JsonSchema | null,
    defaults: unknown,
    subcharts: string[] = [],
): ManifestDiagnostic[] {
    return diagnoseValues(readValues(text), schema, defaults, subcharts);
}
