import { ApiException, HttpMethod, IsomorphicFetchHttpLibrary, RequestContext } from '@kubernetes/client-node';
import { currentAbortSignal } from './abort.js';
import { kubeConfig } from './client.js';
import { K8sError } from './errors.js';

/**
 * The client library's own sender. It sends with the `undici` package's `fetch`, the one the
 * dispatcher the kubeconfig builds (TLS, client certificates, the proxy) belongs to; the `fetch`
 * Node bundles carries a different copy of undici and refuses that dispatcher outright ("invalid
 * onRequestStart method"), which failed every lookup on every cluster.
 */
const http = new IsomorphicFetchHttpLibrary();

/**
 * One GET against the API server, authenticated the way every other call is. The client library
 * generates no client for `/openapi/v3` or for discovering an arbitrary group-version, so the
 * request is built the way the library builds its own: a request context the kubeconfig applies credentials and a dispatcher to, sent by the
 * library's own sender. A 404 is the answer "this server publishes no such document" rather than a
 * failure.
 */
export async function clusterGet(relativeUrl: string, op: string): Promise<unknown> {
    const kc = kubeConfig();
    const cluster = kc.getCurrentCluster();
    if (!cluster) {
        throw new K8sError('kubeconfig', 'The current context names a cluster the kubeconfig does not define.', op);
    }
    const url = `${cluster.server.replace(/\/+$/, '')}${relativeUrl}`;
    const request = new RequestContext(url, HttpMethod.GET);
    request.setHeaderParam('Accept', 'application/json');
    await kc.applySecurityAuthentication(request);
    // This request is built by hand rather than by a generated client, so the ceiling's signal has
    // to be put on it here; without it the read would outlive the call that asked for it.
    const signal = currentAbortSignal();
    if (signal) request.setSignal(signal);
    const response = await http.send(request).toPromise();
    const status = response.httpStatusCode;
    if (status === 404) return null;
    if (status < 200 || status >= 300) throw new ApiException(status, `GET ${relativeUrl} failed`, undefined, {});
    return JSON.parse(await response.body.text()) as unknown;
}
