import type { GroupVersionKind, SchemaNode } from '../../../shared/k8s/openapi.js';
import { refName } from '../../../shared/k8s/openapi.js';

/*
 * Pure reading of what the API server publishes under `/openapi/v3`: the listing of documents, the
 * hash each one is keyed by, and the schemas inside one. Nothing here reaches the cluster, so the
 * whole shape of the feature is testable against fixtures.
 */

/** Where a group-version's document lives, as the discovery listing names it. */
export function documentPath(apiVersion: string): string {
    return apiVersion.includes('/') ? `apis/${apiVersion}` : `api/${apiVersion}`;
}

/** The group and version of a manifest's `apiVersion`; the core group is the empty string. */
export function splitApiVersion(apiVersion: string): { group: string; version: string } {
    const slash = apiVersion.indexOf('/');
    return slash === -1
        ? { group: '', version: apiVersion }
        : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Only a relative URL under the OpenAPI endpoint is followed. The listing comes from the cluster,
 * and the URL is joined to the API server's address and sent with the user's credentials, so an
 * entry pointing anywhere else (another host, or a path that would read objects) is dropped rather
 * than trusted because the server said it.
 */
const DOCUMENT_URL = /^\/openapi\/v3\/[^?#]*(\?[^#]*)?$/;

/**
 * The documents the cluster publishes, keyed by the path they are listed under (`apis/apps/v1`).
 * Null when the body is not a listing at all, which is how a cluster that publishes no OpenAPI v3
 * is told apart from one that publishes an empty one.
 */
export function parseDiscovery(value: unknown): Map<string, string> | null {
    if (!isRecord(value) || !isRecord(value.paths)) return null;
    const paths = new Map<string, string>();
    for (const [path, entry] of Object.entries(value.paths)) {
        if (!isRecord(entry)) continue;
        const url = entry.serverRelativeURL;
        if (typeof url === 'string' && DOCUMENT_URL.test(url)) paths.set(path, url);
    }
    return paths;
}

/**
 * The hash the API server stamps a document's URL with. It changes exactly when the document does,
 * which is what a cached copy is keyed by; without one nothing is cached, since a key that is not
 * the server's own would go stale unnoticed.
 */
export function hashOf(serverRelativeURL: string): string | null {
    const query = serverRelativeURL.indexOf('?');
    if (query === -1) return null;
    return new URLSearchParams(serverRelativeURL.slice(query + 1)).get('hash');
}

function stringOf(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function stringsOf(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : undefined;
}

function nodesOf(value: unknown): SchemaNode[] | undefined {
    return Array.isArray(value) ? value.map(normalizeNode) : undefined;
}

function gvksOf(value: unknown): GroupVersionKind[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const gvks: GroupVersionKind[] = [];
    for (const item of value) {
        if (!isRecord(item)) return undefined;
        const { group, version, kind } = item;
        if (typeof group !== 'string' || typeof version !== 'string' || typeof kind !== 'string') return undefined;
        gvks.push({ group, version, kind });
    }
    return gvks;
}

function set<K extends keyof SchemaNode>(node: SchemaNode, key: K, value: SchemaNode[K] | undefined): void {
    if (value !== undefined) node[key] = value;
}

/**
 * One node reduced to the fields the editor reads. A document is megabytes of which most is never
 * looked at, and a field kept here is one that crosses the bridge for every kind opened. Anything
 * malformed is left out rather than refused: a single odd node in a cluster's own document must
 * not cost the whole kind its schema.
 */
export function normalizeNode(value: unknown): SchemaNode {
    const node: SchemaNode = {};
    if (!isRecord(value)) return node;
    set(node, '$ref', stringOf(value.$ref));
    set(node, 'type', stringOf(value.type));
    set(node, 'format', stringOf(value.format));
    set(node, 'description', stringOf(value.description));
    if ('default' in value) node.default = value.default;
    set(node, 'enum', Array.isArray(value.enum) ? [...value.enum] : undefined);
    set(node, 'required', stringsOf(value.required));
    set(node, 'nullable', typeof value.nullable === 'boolean' ? value.nullable : undefined);
    if (isRecord(value.properties)) {
        const properties: Record<string, SchemaNode> = {};
        for (const [name, property] of Object.entries(value.properties)) properties[name] = normalizeNode(property);
        node.properties = properties;
    }
    if (isRecord(value.items)) node.items = normalizeNode(value.items);
    if (typeof value.additionalProperties === 'boolean') node.additionalProperties = value.additionalProperties;
    else if (isRecord(value.additionalProperties))
        node.additionalProperties = normalizeNode(value.additionalProperties);
    set(node, 'allOf', nodesOf(value.allOf));
    set(node, 'oneOf', nodesOf(value.oneOf));
    set(node, 'anyOf', nodesOf(value.anyOf));
    set(node, 'x-kubernetes-group-version-kind', gvksOf(value['x-kubernetes-group-version-kind']));
    const intOrString = value['x-kubernetes-int-or-string'];
    if (typeof intOrString === 'boolean') node['x-kubernetes-int-or-string'] = intOrString;
    const preserve = value['x-kubernetes-preserve-unknown-fields'];
    if (typeof preserve === 'boolean') node['x-kubernetes-preserve-unknown-fields'] = preserve;
    return node;
}

/** A map of definitions, each normalised; anything that is not a map reads as none. */
export function normalizeDefinitions(value: unknown): Record<string, SchemaNode> {
    if (!isRecord(value)) return {};
    const definitions: Record<string, SchemaNode> = {};
    for (const [name, node] of Object.entries(value)) definitions[name] = normalizeNode(node);
    return definitions;
}

/** The definitions a whole OpenAPI v3 document publishes. */
export function normalizeSchemas(document: unknown): Record<string, SchemaNode> {
    if (!isRecord(document) || !isRecord(document.components)) return {};
    return normalizeDefinitions(document.components.schemas);
}

/**
 * The definition describing a kind, found by what it says it describes rather than by its name:
 * `x-kubernetes-group-version-kind` is on every top-level schema, a custom resource's included,
 * while the name is a Go package path no client should have to guess at.
 */
export function findKindName(definitions: Record<string, SchemaNode>, gvk: GroupVersionKind): string | null {
    for (const [name, node] of Object.entries(definitions)) {
        const declared = node['x-kubernetes-group-version-kind'] ?? [];
        const match = declared.some(
            (one) => one.group === gvk.group && one.version === gvk.version && one.kind === gvk.kind,
        );
        if (match) return name;
    }
    return null;
}

/** Every `$ref` a node names, at any depth inside it. */
function referencesOf(node: SchemaNode): string[] {
    const names: string[] = [];
    const walk = (current: SchemaNode | boolean | undefined): void => {
        if (typeof current !== 'object' || current === undefined) return;
        if (current.$ref) {
            const name = refName(current.$ref);
            if (name) names.push(name);
        }
        for (const child of Object.values(current.properties ?? {})) walk(child);
        walk(current.items);
        walk(current.additionalProperties);
        for (const branch of [...(current.allOf ?? []), ...(current.oneOf ?? []), ...(current.anyOf ?? [])]) {
            walk(branch);
        }
    };
    walk(node);
    return names;
}

/**
 * A definition together with everything it reaches, which is the whole of what one kind needs and
 * a fraction of the document it came from. A schema that refers to itself is visited once.
 */
export function closure(definitions: Record<string, SchemaNode>, name: string): Record<string, SchemaNode> {
    const reached: Record<string, SchemaNode> = {};
    const pending = [name];
    while (pending.length > 0) {
        const next = pending.pop();
        if (next === undefined || next in reached) continue;
        const node = definitions[next];
        if (!node) continue;
        reached[next] = node;
        pending.push(...referencesOf(node));
    }
    return reached;
}
