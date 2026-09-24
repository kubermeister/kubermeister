import type { KindSchema, SchemaNode } from '../../shared/k8s/openapi';
import { describeTypes, resolve, type Resolved } from './manifest-validation';

/**
 * Where the cursor is in a manifest and what the kind's schema says about it, for completion and
 * for the description shown over a field, without a DOM, so both are tested on fixture schemas.
 *
 * The position is read from the lines above the cursor rather than from a parse, because the text
 * being completed is usually not valid YAML yet: `  repl` with no colon is exactly the moment a
 * completion is wanted. A line's key column and its `- ` markers are enough to tell which mapping
 * or list item it belongs to, in the block style manifests are written in.
 */

/** One step from the root to the cursor: a field of a mapping, or an item of a list. */
export type PathStep = { key: string } | { item: true };

interface Line {
    /** Where each `- ` marker starts, outermost first. */
    dashes: number[];
    /** The column the line's key or scalar starts at, past its markers. */
    column: number;
    key: string | null;
    /** Whatever follows `key:` on the line, trimmed. */
    value: string;
}

const KEY_LINE = /^([A-Za-z0-9_.\-/$]+|"[^"]*"|'[^']*'):(?:\s+(.*))?$/;

function readLine(raw: string): Line | null {
    const trimmed = raw.trimEnd();
    if (trimmed.trim() === '' || trimmed.trimStart().startsWith('#')) return null;
    const dashes: number[] = [];
    let column = trimmed.length - trimmed.trimStart().length;
    while (trimmed.startsWith('- ', column) || (trimmed.endsWith('-') && column === trimmed.length - 1)) {
        dashes.push(column);
        column += 1;
        while (trimmed[column] === ' ') column += 1;
    }
    const rest = trimmed.slice(column);
    const match = KEY_LINE.exec(rest);
    const key = match?.[1]?.replace(/^["']|["']$/g, '') ?? null;
    return { dashes, column, key, value: match?.[2]?.trim() ?? '' };
}

/**
 * The path to the mapping a line at `column` belongs to, read upwards from `lines`. A line at the
 * same column that starts a list item means this line is inside that item; a `key:` with nothing
 * after it, further left, is the field holding it. `afterDash` is for a line that itself starts an
 * item: the field holding the list may then sit at the marker's own column, as kubectl writes it.
 * Null when the lines above do not read as block YAML, which is no place to offer anything.
 */
function pathAbove(lines: (Line | null)[], column: number, afterDash = false): PathStep[] | null {
    const path: PathStep[] = [];
    let col = column;
    let justLeftItem = afterDash;
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index];
        if (!line) continue;
        const itemStart = line.dashes.length > 0 ? line.dashes[line.dashes.length - 1]! : null;
        if (!justLeftItem && line.column === col && itemStart !== null && itemStart < col) {
            path.unshift({ item: true });
            col = itemStart;
            justLeftItem = true;
            continue;
        }
        const isParent = line.column < col || (justLeftItem && line.column === col && itemStart === null);
        if (!isParent) continue;
        if (!line.key || line.value !== '') return null;
        path.unshift({ key: line.key });
        col = line.column;
        justLeftItem = false;
        if (itemStart !== null) {
            path.unshift({ item: true });
            col = itemStart;
            justLeftItem = true;
        }
    }
    return path;
}

/**
 * The path to the mapping a line starting with `prefix` (its indentation and any `- ` markers)
 * writes into. A marker opens a new item of the list the lines above hold.
 */
function pathForLine(above: (Line | null)[], prefix: string): PathStep[] | null {
    const line = readLine(`${prefix}x`);
    if (!line) return null;
    if (line.dashes.length === 0) return pathAbove(above, line.column);
    let path = pathAbove(above, line.dashes[0]!, true);
    if (!path) return null;
    // `- - key` nests one list in another; each marker is an item of the one before.
    for (let marker = 0; marker < line.dashes.length; marker++) path = [...path, { item: true }];
    return path;
}

/** The schema at the end of a path, or null where the schema has nothing to say. */
function schemaAt(schema: KindSchema, path: PathStep[]): Resolved | null {
    let node: SchemaNode | undefined = schema.definitions[schema.name];
    for (const step of path) {
        const resolved = resolve(node, schema.definitions);
        if ('item' in step) node = resolved.items;
        else
            node =
                resolved.properties[step.key] ??
                (typeof resolved.additionalProperties === 'object' ? resolved.additionalProperties : undefined);
        if (!node) return null;
    }
    return resolve(node, schema.definitions);
}

/**
 * The keys the mapping on line `at` already has, at `column`: upwards to the line that opened it
 * (a parent, or the marker starting this item) and downwards to where it ends.
 */
function siblings(lines: (Line | null)[], at: number, column: number): Set<string> {
    const keys = new Set<string>();
    const startsItem = (line: Line) => line.dashes.length > 0 && line.dashes[line.dashes.length - 1]! < column;
    for (let index = at - 1; index >= 0; index--) {
        const line = lines[index];
        if (!line || line.column > column) continue;
        if (line.column < column) break;
        if (line.key) keys.add(line.key);
        if (startsItem(line)) break;
    }
    for (let index = at + 1; index < lines.length; index++) {
        const line = lines[index];
        if (!line || line.column > column) continue;
        if (line.column < column || startsItem(line)) break;
        if (line.key) keys.add(line.key);
    }
    return keys;
}

export interface CompletionItem {
    label: string;
    /** What the completion writes: a field with its colon, or a value as it stands. */
    apply: string;
    type: 'property' | 'enum' | 'keyword';
    detail?: string;
    info?: string;
    /** Required fields come first; nothing else is ranked by the schema. */
    boost?: number;
}

export interface Completions {
    /** Where the word being completed starts, which a chosen completion replaces up to the cursor. */
    from: number;
    options: CompletionItem[];
}

function lineStart(text: string, offset: number): number {
    return text.lastIndexOf('\n', offset - 1) + 1;
}

/** What may follow the cursor at `offset`: the fields of the mapping it is in, or the values a field allows. */
export function completionsAt(text: string, offset: number, schema: KindSchema): Completions | null {
    const start = lineStart(text, offset);
    const end = text.indexOf('\n', offset);
    const before = text.slice(start, offset);
    const index = text.slice(0, start).split('\n').length - 1;
    const lines = text.split('\n').map(readLine);
    const above = lines.slice(0, index);

    const valueMatch = /^(\s*(?:-\s+)*)([A-Za-z0-9_.\-/]+):\s+(\S*)$/.exec(before);
    if (valueMatch) {
        const path = pathForLine(above, valueMatch[1]!);
        const field = path && schemaAt(schema, [...path, { key: valueMatch[2]! }]);
        if (!field) return null;
        const values = field.enum ?? (field.types.includes('boolean') ? [true, false] : []);
        if (values.length === 0) return null;
        return {
            from: offset - valueMatch[3]!.length,
            options: values.map((value) => ({
                label: String(value),
                apply: String(value),
                type: typeof value === 'boolean' ? 'keyword' : 'enum',
            })),
        };
    }

    const keyMatch = /^(\s*(?:-\s+)*)([A-Za-z0-9_.\-/]*)$/.exec(before);
    // Only the start of a line is a key, and one already followed by its colon is being retyped.
    if (!keyMatch || (end !== -1 ? text.slice(offset, end) : text.slice(offset)).includes(':')) return null;
    const prefix = keyMatch[1]!;
    const path = pathForLine(above, prefix);
    const mapping = path && schemaAt(schema, path);
    if (!mapping?.hasProperties) return null;
    // A marker opens a new item, which has no keys yet; otherwise the mapping's own are left out.
    const present = /-\s*$/.test(prefix) ? new Set<string>() : siblings(lines, index, prefix.length);
    const required = new Set(mapping.required);
    const options = Object.entries(mapping.properties)
        .filter(([key]) => !present.has(key))
        .map(([key, node]): CompletionItem => {
            const field = resolve(node, schema.definitions);
            const nested = field.types.includes('object') || field.types.includes('array');
            const detail = [
                required.has(key) ? 'required' : null,
                field.types.length > 0 ? describeTypes(field.types) : null,
            ];
            return {
                label: key,
                apply: nested ? `${key}:` : `${key}: `,
                type: 'property',
                detail: detail.filter(Boolean).join(' · '),
                info: field.description,
                boost: required.has(key) ? 1 : 0,
            };
        });
    return options.length > 0 ? { from: offset - keyMatch[2]!.length, options } : null;
}

export interface FieldDescription {
    from: number;
    to: number;
    /** The field's name, what it holds and what the schema says it is for. */
    title: string;
    detail: string;
    description: string | null;
}

/** What the field whose name is under `offset` is, for the tooltip over it. */
export function describeAt(text: string, offset: number, schema: KindSchema): FieldDescription | null {
    const start = lineStart(text, offset);
    const end = text.indexOf('\n', offset);
    const raw = text.slice(start, end === -1 ? text.length : end);
    const line = readLine(raw);
    if (!line?.key) return null;
    const keyFrom = start + line.column;
    const keyTo = keyFrom + raw.slice(line.column).indexOf(':');
    if (offset < keyFrom || offset > keyTo) return null;
    const index = text.slice(0, start).split('\n').length - 1;
    const above = text.split('\n').slice(0, index).map(readLine);
    const parent = pathForLine(above, raw.slice(0, line.column));
    if (!parent) return null;
    const path: PathStep[] = [...parent, { key: line.key }];
    const field = schemaAt(schema, path);
    if (!field) return null;
    const required = schemaAt(schema, path.slice(0, -1))?.required.includes(line.key) ?? false;
    return {
        from: keyFrom,
        to: keyTo,
        title: line.key,
        detail: [field.types.length > 0 ? describeTypes(field.types) : 'any value', required ? 'required' : null]
            .filter(Boolean)
            .join(' · '),
        description: field.description ?? null,
    };
}
