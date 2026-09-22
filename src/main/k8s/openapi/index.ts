import { ApiException, HttpMethod, RequestContext } from '@kubernetes/client-node';
import type { KindSchema, KindSchemaInput, SchemaNode } from '../../../shared/k8s/openapi.js';
import { currentAbortSignal } from '../abort.js';
import { activeContextName, kubeConfig } from '../client.js';
import { K8sError, withK8s } from '../errors.js';
import { readCachedDocument, writeCachedDocument } from './cache.js';
import {
    closure,
    documentPath,
    findKindName,
    hashOf,
    normalizeSchemas,
    parseDiscovery,
    splitApiVersion,
} from './document.js';

/**
 * The cluster's own schema for a kind, read from the OpenAPI v3 documents the API server publishes
 * and answered to the renderer, which never talks to the cluster itself. A kind the cluster serves
 * no schema for is not a failure: the editor falls back to plain YAML, so the answer is null and
 * only a read that actually failed rejects.
 */

const OP = 'schemas.forKind';

/**
 * How long the listing of documents is reused. It is small, and its job is to say which hash each
 * document currently has, so it has to be asked again for a change to be noticed at all; a minute
 * keeps a burst of lookups to one request while a definition installed just now still appears
 * without restarting the app.
 */
const LISTING_TTL_MS = 60_000;

let listing: { context: string; at: number; paths: Map<string, string> } | null = null;

/** Documents already read this session, keyed by context and by the exact URL they came from. */
const documents = new Map<string, Record<string, SchemaNode>>();

/**
 * Forget what was read from the cluster being left. The disk cache is keyed by context and stays:
 * what is dropped here is memory, which the next connection must not answer from, since the same
 * context name can be pointed at a different cluster by a kubeconfig change.
 */
export function resetSchemaCache(): void {
    listing = null;
    documents.clear();
}

/**
 * One GET against the API server, authenticated the way every other call is. The client library
 * generates no client for `/openapi/v3`, so the request is built the way the library builds its
 * own: a request context the kubeconfig applies credentials and a dispatcher to. A 404 is the
 * answer "this server publishes no such document" rather than a failure.
 */
async function clusterGet(relativeUrl: string): Promise<unknown> {
    const kc = kubeConfig();
    const cluster = kc.getCurrentCluster();
    if (!cluster) {
        throw new K8sError('kubeconfig', 'The current context names a cluster the kubeconfig does not define.', OP);
    }
    const url = `${cluster.server.replace(/\/+$/, '')}${relativeUrl}`;
    const request = new RequestContext(url, HttpMethod.GET);
    request.setHeaderParam('Accept', 'application/json');
    await kc.applySecurityAuthentication(request);
    const response = await fetch(url, {
        method: 'GET',
        headers: request.getHeaders(),
        // This request is built by hand rather than by a generated client, so the ceiling's signal
        // has to be put on it here; without it the read would outlive the call that asked for it.
        signal: currentAbortSignal(),
        // The library bundles its own copy of undici's types, so the dispatcher it hands back is
        // the same object under a second name; the cast is between the two copies, not two things.
        dispatcher: request.getDispatcher() as RequestInit['dispatcher'],
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new ApiException(response.status, `GET ${relativeUrl} failed`, undefined, {});
    return response.json();
}

/** The documents this cluster publishes, asked for again once the memo is old enough. */
async function documentListing(context: string): Promise<Map<string, string> | null> {
    if (listing && listing.context === context && Date.now() - listing.at < LISTING_TTL_MS) return listing.paths;
    const body = await clusterGet('/openapi/v3');
    const paths = body === null ? null : parseDiscovery(body);
    if (!paths) return null;
    listing = { context, at: Date.now(), paths };
    return paths;
}

/**
 * One document's definitions: from this session, else from the copy on disk the cluster's hash
 * still matches, else from the cluster. A document the server gives no hash for is read every
 * session rather than cached, since the only honest key for a cached copy is the server's own.
 */
async function definitionsOf(context: string, path: string, url: string): Promise<Record<string, SchemaNode> | null> {
    const key = `${context}\n${url}`;
    const remembered = documents.get(key);
    if (remembered) return remembered;

    const hash = hashOf(url);
    const cached = hash ? readCachedDocument(context, path, hash) : null;
    if (cached) {
        documents.set(key, cached);
        return cached;
    }

    const body = await clusterGet(url);
    if (body === null) return null;
    const definitions = normalizeSchemas(body);
    if (hash) writeCachedDocument(context, path, hash, definitions);
    documents.set(key, definitions);
    return definitions;
}

/** The schema of one kind, or null when this cluster describes no such kind. */
export function getKindSchema({ apiVersion, kind }: KindSchemaInput): Promise<KindSchema | null> {
    return withK8s(OP, async () => {
        const context = activeContextName();
        const paths = await documentListing(context);
        const path = documentPath(apiVersion);
        const url = paths?.get(path);
        if (!url) return null;

        const definitions = await definitionsOf(context, path, url);
        if (!definitions) return null;

        const name = findKindName(definitions, { ...splitApiVersion(apiVersion), kind });
        if (!name) return null;
        return { apiVersion, kind, document: path, name, definitions: closure(definitions, name) };
    });
}
