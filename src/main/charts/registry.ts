import { sendsCredentialsInClear } from '../../shared/charts.js';
import { K8sError, toK8sError } from '../k8s/errors.js';

/**
 * OCI registries speak the Docker registry v2 protocol, which has no index to download: the only
 * thing that can be checked about a configured registry is that it answers and that the credential
 * it was given is accepted. That is exactly what `helm registry login` does, and it is done here
 * the same way — ping `/v2/`, and answer the bearer challenge a registry replies with.
 */

/** How long a registry has to answer before the check gives up. */
export const REGISTRY_TIMEOUT_MS = 15_000;

export interface RegistryCredential {
    username: string;
    password: string;
}

export interface RegistryChallenge {
    realm: string;
    service?: string;
    /** What the token is for, e.g. `repository:example/nginx:pull`; the ping's challenge names none. */
    scope?: string;
}

/** `oci://host[:port]/path` names a registry; `/v2/` on it over https is the API root. */
export function registryPingUrl(url: string): string {
    return `https://${new URL(url).host}/v2/`;
}

/**
 * The bearer challenge a registry answers a 401 with. Anything else — no header, another scheme, no
 * realm, or a realm that is not a URL — is nothing to answer, since the credential would otherwise
 * be sent wherever the header said.
 */
export function parseAuthChallenge(header: string | null): RegistryChallenge | null {
    if (!header || !/^bearer\s/i.test(header)) return null;
    const field = (name: string): string | undefined =>
        new RegExp(`${name}="([^"]*)"`, 'i').exec(header)?.[1] || undefined;
    const realm = field('realm');
    if (!realm) return null;
    try {
        const { protocol } = new URL(realm);
        if (protocol !== 'https:' && protocol !== 'http:') return null;
    } catch {
        return null;
    }
    return { realm, service: field('service'), scope: field('scope') };
}

export function basicAuth(credential: RegistryCredential | null): Record<string, string> {
    if (!credential) return {};
    const encoded = Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64');
    return { authorization: `Basic ${encoded}` };
}

/** What an HTTP answer means, in the vocabulary the renderer already renders. */
export function httpFailure(op: string, status: number, what: string): K8sError {
    if (status === 401) return new K8sError('unauthorized', `${what} rejected the credentials.`, op);
    if (status === 403) return new K8sError('forbidden', `${what} denied access.`, op);
    if (status === 404) return new K8sError('notFound', `${what} has nothing at that address.`, op);
    return new K8sError('unknown', `${what} answered ${status}.`, op);
}

/**
 * The realm is whatever the registry's header named, so it is held to the rule a repository URL is:
 * over plaintext http it is asked for a token anonymously, and the password never crosses the
 * network readable.
 */
async function tokenFor(challenge: RegistryChallenge, credential: RegistryCredential | null): Promise<string | null> {
    const url = new URL(challenge.realm);
    if (challenge.service) url.searchParams.set('service', challenge.service);
    if (challenge.scope) url.searchParams.set('scope', challenge.scope);
    const authorization = sendsCredentialsInClear(challenge.realm) ? {} : basicAuth(credential);
    const response = await fetch(url.toString(), {
        headers: { accept: 'application/json', ...authorization },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json().catch(() => null);
    if (typeof body !== 'object' || body === null) return null;
    const { token, access_token: accessToken } = body as { token?: unknown; access_token?: unknown };
    if (typeof token === 'string' && token) return token;
    return typeof accessToken === 'string' && accessToken ? accessToken : null;
}

/**
 * A GET against a registry that answers the bearer challenge the way `helm` does: the credential
 * goes as basic auth first, a 401 carrying a challenge is answered with a token for the scope it
 * names, and that token is kept for the next request, so a manifest and the blob it points at cost
 * one token rather than two. The answer is returned whatever its status; the caller says what a
 * failure means.
 */
export function registryClient(credential: RegistryCredential | null, timeoutMs = REGISTRY_TIMEOUT_MS) {
    let bearer: string | null = null;
    return async (url: string, headers: Record<string, string> = {}): Promise<Response> => {
        const request = (authorization: Record<string, string>) =>
            fetch(url, { headers: { ...headers, ...authorization }, signal: AbortSignal.timeout(timeoutMs) });
        let response = await request(bearer ? { authorization: `Bearer ${bearer}` } : basicAuth(credential));
        if (response.status === 401) {
            const challenge = parseAuthChallenge(response.headers.get('www-authenticate'));
            const token = challenge ? await tokenFor(challenge, credential) : null;
            if (token) {
                bearer = token;
                response = await request({ authorization: `Bearer ${token}` });
            }
        }
        return response;
    };
}

/** Check that a registry answers and accepts the credential it was given; throws a classified failure. */
export async function pingRegistry(op: string, url: string, credential: RegistryCredential | null): Promise<void> {
    try {
        const response = await registryClient(credential)(registryPingUrl(url));
        if (!response.ok) throw httpFailure(op, response.status, 'The registry');
    } catch (error) {
        throw toK8sError(op, error);
    }
}
