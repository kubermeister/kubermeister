import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SchemaNode } from '../../../shared/k8s/openapi.js';
import { normalizeDefinitions } from './document.js';

/**
 * The on-disk copy of the group-version documents a cluster publishes. A document is megabytes and
 * changes only when the cluster's own kinds do, so it is kept between launches and keyed by the
 * hash the API server stamps its URL with: a document whose hash still matches is the document the
 * cluster is serving, and one whose hash moved on is replaced rather than merged.
 *
 * Every copy is filed under the context it came from, because a group-version means different
 * things on two clusters. A cache failure is never thrown: the reader falls back to the cluster,
 * which is where the answer comes from anyway.
 */

/** Characters a file name may carry on every platform the app ships on. */
function safe(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * A context's own directory. Context names carry slashes and colons (an EKS ARN is one), so the
 * name is both flattened, to stay readable, and digested, so two contexts that flatten alike are
 * still two directories.
 */
export function contextKey(context: string): string {
    return `${safe(context).slice(0, 40)}-${digest(context)}`;
}

/** A document's file name stem: `apis/apps/v1` reads back as `apis_apps_v1`. */
export function documentKey(path: string): string {
    return safe(path);
}

function contextDir(context: string): string {
    return join(app.getPath('userData'), 'openapi', contextKey(context));
}

/** Where one document of one context is cached; the hash is digested, being the server's own opaque value. */
export function documentFile(context: string, path: string, hash: string): string {
    return join(contextDir(context), `${documentKey(path)}.${digest(hash)}.json`);
}

/**
 * The cached definitions for this exact document and hash, or null when there are none. What comes
 * back is normalised rather than trusted: the file is on the user's disk, and the editor is handed
 * a shape the contract describes whatever the file holds.
 */
export function readCachedDocument(context: string, path: string, hash: string): Record<string, SchemaNode> | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(documentFile(context, path, hash), 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
        return normalizeDefinitions(parsed);
    } catch {
        // Missing (the common case, a first read), unreadable, or not JSON: read from the cluster.
        return null;
    }
}

/** Replace the cached copy of one document, dropping the copies of the hashes it has moved on from. */
export function writeCachedDocument(
    context: string,
    path: string,
    hash: string,
    definitions: Record<string, SchemaNode>,
): void {
    const file = documentFile(context, path, hash);
    try {
        const dir = contextDir(context);
        mkdirSync(dir, { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(definitions), 'utf8');
        renameSync(tmp, file);
        prune(dir, file, `${documentKey(path)}.`);
    } catch (error) {
        console.error('[openapi] failed to cache a schema document', error);
    }
}

/** Drop every earlier copy of this document, which its hash has replaced. */
function prune(dir: string, keep: string, stem: string): void {
    for (const entry of readdirSync(dir)) {
        const file = join(dir, entry);
        if (file !== keep && entry.startsWith(stem)) rmSync(file, { force: true });
    }
}
