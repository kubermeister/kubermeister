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
    return { realm, service: field('service') };
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

async function tokenFor(challenge: RegistryChallenge, credential: RegistryCredential | null): Promise<string | null> {
    const url = new URL(challenge.realm);
    if (challenge.service) url.searchParams.set('service', challenge.service);
    const response = await fetch(url.toString(), {
        headers: { accept: 'application/json', ...basicAuth(credential) },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json().catch(() => null);
    if (typeof body !== 'object' || body === null) return null;
    const { token, access_token: accessToken } = body as { token?: unknown; access_token?: unknown };
    if (typeof token === 'string' && token) return token;
    return typeof accessToken === 'string' && accessToken ? accessToken : null;
}

/** Check that a registry answers and accepts the credential it was given; throws a classified failure. */
export async function pingRegistry(op: string, url: string, credential: RegistryCredential | null): Promise<void> {
    const ping = registryPingUrl(url);
    const request = (headers: Record<string, string>) =>
        fetch(ping, { headers, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    try {
        let response = await request(basicAuth(credential));
        if (response.status === 401) {
            const challenge = parseAuthChallenge(response.headers.get('www-authenticate'));
            const token = challenge ? await tokenFor(challenge, credential) : null;
            if (token) response = await request({ authorization: `Bearer ${token}` });
        }
        if (!response.ok) throw httpFailure(op, response.status, 'The registry');
    } catch (error) {
        throw toK8sError(op, error);
    }
}
