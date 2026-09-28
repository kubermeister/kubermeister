import { isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml';
import { rangeOf, type ManifestDiagnostic, type Range } from './manifest-validation';

/**
 * A failed render, read back onto the values that caused it. Helm's message is all there is — the
 * render step hands on its own words, one line per line — so this reads the forms Helm writes: a
 * schema failure listing each refused value by path (Helm 4's JSON Pointers and Helm 3's dotted
 * fields), a `required` or `fail` naming its template, and a template that failed on a value it read
 * (`<.Values.image.tag>`). Each is marked on the value it names, the nearest one the text holds;
 * what names no value is a note beside the editor. Pure, so it is tested on Helm's own messages.
 */

export interface RenderProblem {
    /** The value the problem is about, from the top of the values; null when Helm names none. */
    path: string[] | null;
    message: string;
    /** The template and line Helm names, when it names one. */
    where: string | null;
}

export interface ReadRenderError {
    /** One sentence saying what kind of failure it was. */
    summary: string;
    problems: RenderProblem[];
}

export interface RenderNote {
    message: string;
    where: string | null;
}

export interface PlacedRenderError {
    summary: string;
    /** The problems marked on a value of the text. */
    diagnostics: ManifestDiagnostic[];
    /** The problems no value of the text stands for, shown beside the editor. */
    notes: RenderNote[];
}

const SCHEMA_FAILURE = /^values don't meet the specifications of the schema\(s\)/;
const CHART_HEADING = /^([A-Za-z0-9][\w.-]*):$/;
/** Helm 4: `- at '/image/tag': got number, want string`. */
const POINTER_LINE = /^- at '([^']*)': (.*)$/;
/** Helm 3: `- image.tag: Invalid type. Expected: string, given: integer`, or `(root)` for the top. */
const FIELD_LINE = /^- (\(root\)|[^\s:]+): (.*)$/;
/** Helm 4 heads the problems below a value with this line, which says nothing itself. */
const WRAPPER = 'validation failed';
const EXECUTION_ERROR = /execution error at \(([^)]+?):(\d+)(?::\d+)?\): ([\s\S]*)$/;
const VALUES_REFERENCE = /<\.Values\.([\w.]+)>/;
const TEMPLATE_PLACE = /([\w.@-]+(?:\/[\w.@-]+)*\/templates\/[\w.@/-]+?):(\d+)(?::\d+)?/;
const NIL_POINTER = /nil pointer evaluating interface \{\}\.(\S+)/;

function pointerPath(pointer: string): string[] {
    if (pointer === '') return [];
    return pointer
        .replace(/^\//, '')
        .split('/')
        .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function readSchemaFailure(lines: string[]): RenderProblem[] {
    const problems: RenderProblem[] = [];
    // The first chart listed is the one being rendered; a subchart's values sit under its name.
    let prefix: string[] | null = null;
    for (const line of lines.slice(1)) {
        const heading = CHART_HEADING.exec(line);
        if (heading) {
            prefix = prefix === null ? [] : [heading[1]!];
            continue;
        }
        const base = prefix ?? [];
        const pointer = POINTER_LINE.exec(line);
        if (pointer) {
            if (pointer[2] !== WRAPPER) {
                problems.push({ path: [...base, ...pointerPath(pointer[1]!)], message: pointer[2]!, where: null });
            }
            continue;
        }
        const field = FIELD_LINE.exec(line);
        if (field) {
            const path = field[1] === '(root)' ? [] : field[1]!.split('.');
            problems.push({ path: [...base, ...path], message: field[2]!, where: null });
        }
    }
    return problems;
}

/** A template's failure on a value it read, in words about the value rather than Go's. */
function readTemplateFailure(message: string, lines: string[]): RenderProblem {
    const place = TEMPLATE_PLACE.exec(message);
    const where = place ? `${place[1]}, line ${place[2]}` : null;
    const reference = VALUES_REFERENCE.exec(message);
    if (!reference) return { path: null, message: lines.join(' '), where };
    const path = reference[1]!.split('.').filter(Boolean);
    // Helm 4 puts the reason on a line of its own, Helm 3 after the reference on the same line.
    const last = lines[lines.length - 1] ?? '';
    const reason = last.replace(/^.*<\.Values\.[\w.]+>:\s*/, '') || lines.join(' ');
    const nil = NIL_POINTER.exec(last);
    const unset = nil ? path[path.indexOf(nil[1]!) - 1] : undefined;
    return {
        path,
        message: unset ? `The chart reads .Values.${path.join('.')}, but "${unset}" is not set.` : reason,
        where,
    };
}

/** What a render error says, and about which values. */
export function readRenderError(message: string): ReadRenderError {
    const lines = message
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    if (SCHEMA_FAILURE.test(lines[0] ?? '')) {
        return { summary: 'The values do not match the chart’s schema.', problems: readSchemaFailure(lines) };
    }
    const summary = 'The chart did not render with these values.';
    const execution = EXECUTION_ERROR.exec(message);
    if (execution) {
        return {
            summary,
            problems: [{ path: null, message: execution[3]!.trim(), where: `${execution[1]}, line ${execution[2]}` }],
        };
    }
    return { summary, problems: [readTemplateFailure(message, lines)] };
}

/**
 * The key of the deepest value along `path` the text holds, or null when it holds none of it. An
 * item of a list is marked on its first line.
 */
function keyAlong(root: Node | null, path: string[]): Range | null {
    let node: Node | null = root;
    let found: Range | null = null;
    for (const step of path) {
        if (isMap(node)) {
            const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === step);
            if (!pair) break;
            found = rangeOf(pair.key as Node, [0, 0]);
            node = (pair.value as Node | null) ?? null;
        } else if (isSeq(node) && /^\d+$/.test(step)) {
            const item = (node.items[Number(step)] as Node | undefined) ?? null;
            if (!item) break;
            const first = isMap(item) ? (item.items[0]?.key as Node | undefined) : item;
            found = rangeOf(first, [0, 0]);
            node = item;
        } else {
            break;
        }
    }
    return found;
}

/** A render error laid over the values it was rendered with. */
export function placeRenderError(text: string, message: string): PlacedRenderError {
    const { summary, problems } = readRenderError(message);
    const doc = parseDocument(text, { prettyErrors: false });
    const root = doc.errors.length === 0 ? (doc.contents as Node | null) : null;
    const diagnostics: ManifestDiagnostic[] = [];
    const notes: RenderNote[] = [];
    for (const problem of problems) {
        const at = problem.path ? keyAlong(root, problem.path) : null;
        if (!at) {
            notes.push({ message: problem.message, where: problem.where });
            continue;
        }
        diagnostics.push({
            from: at[0],
            to: at[1],
            severity: 'error',
            message: problem.where ? `${problem.message} (${problem.where})` : problem.message,
        });
    }
    return { summary, diagnostics: diagnostics.sort((a, b) => a.from - b.from), notes };
}
