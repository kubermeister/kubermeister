import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { K8sError } from '../../../src/main/k8s/errors';
import { parseAuthChallenge, pingRegistry, registryPingUrl } from '../../../src/main/charts/registry';

const OP = 'chartRepositories.refresh';
const credential = { username: 'ara', password: 'hunter2' };
const basic = `Basic ${Buffer.from('ara:hunter2', 'utf8').toString('base64')}`;

function reply(status: number, headers: Record<string, string> = {}, body = ''): Response {
    return new Response(body, { status, headers });
}

const fetchMock = vi.fn();

describe('registryPingUrl', () => {
    it('turns an OCI reference into the registry API root the Docker v2 protocol answers on', () => {
        expect(registryPingUrl('oci://ghcr.io/example/charts')).toBe('https://ghcr.io/v2/');
        expect(registryPingUrl('oci://reg.example.com:5000')).toBe('https://reg.example.com:5000/v2/');
    });
});

describe('parseAuthChallenge', () => {
    it('reads the realm and service out of a bearer challenge', () => {
        expect(parseAuthChallenge('Bearer realm="https://auth.docker.io/token",service="registry.docker.io"')).toEqual({
            realm: 'https://auth.docker.io/token',
            service: 'registry.docker.io',
        });
        expect(parseAuthChallenge('bearer realm="https://ghcr.io/token"')).toEqual({
            realm: 'https://ghcr.io/token',
            service: undefined,
        });
    });

    it('is nothing for a challenge with no realm, another scheme, or no header at all', () => {
        expect(parseAuthChallenge(null)).toBeNull();
        expect(parseAuthChallenge('Basic realm="registry"')).toBeNull();
        expect(parseAuthChallenge('Bearer service="registry.docker.io"')).toBeNull();
        // A realm that is not an http(s) URL would send the credential somewhere unknown.
        expect(parseAuthChallenge('Bearer realm="not a url"')).toBeNull();
        expect(parseAuthChallenge('Bearer realm="ftp://auth.example.com/token"')).toBeNull();
    });
});

describe('pingRegistry', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('accepts a registry that answers the ping, sending the credential as basic auth', async () => {
        fetchMock.mockResolvedValue(reply(200));
        await expect(pingRegistry(OP, 'oci://ghcr.io/example', credential)).resolves.toBeUndefined();
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://ghcr.io/v2/');
        expect((init.headers as Record<string, string>).authorization).toBe(basic);
    });

    it('sends no authorization header at all when the registry is used anonymously', async () => {
        fetchMock.mockResolvedValue(reply(200));
        await pingRegistry(OP, 'oci://ghcr.io/example', null);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    });

    it('answers the bearer challenge the registry replies with and pings again with the token', async () => {
        fetchMock
            .mockResolvedValueOnce(
                reply(401, { 'www-authenticate': 'Bearer realm="https://auth.ghcr.io/token",service="ghcr.io"' }),
            )
            .mockResolvedValueOnce(reply(200, {}, JSON.stringify({ token: 'issued-token' })))
            .mockResolvedValueOnce(reply(200));
        await expect(pingRegistry(OP, 'oci://ghcr.io/example', credential)).resolves.toBeUndefined();
        const [tokenUrl, tokenInit] = fetchMock.mock.calls[1] as [string, RequestInit];
        expect(tokenUrl).toBe('https://auth.ghcr.io/token?service=ghcr.io');
        expect((tokenInit.headers as Record<string, string>).authorization).toBe(basic);
        const [, retry] = fetchMock.mock.calls[2] as [string, RequestInit];
        expect((retry.headers as Record<string, string>).authorization).toBe('Bearer issued-token');
    });

    it('takes the access_token some registries answer with instead', async () => {
        fetchMock
            .mockResolvedValueOnce(reply(401, { 'www-authenticate': 'Bearer realm="https://auth.ghcr.io/token"' }))
            .mockResolvedValueOnce(reply(200, {}, JSON.stringify({ access_token: 'other-token' })))
            .mockResolvedValueOnce(reply(200));
        await pingRegistry(OP, 'oci://ghcr.io/example', null);
        expect(fetchMock.mock.calls[1][0]).toBe('https://auth.ghcr.io/token');
        expect((fetchMock.mock.calls[2][1].headers as Record<string, string>).authorization).toBe('Bearer other-token');
    });

    it('reports the credential as rejected when the token endpoint answers with no token', async () => {
        for (const body of ['not json', JSON.stringify({ token: '' }), JSON.stringify([1])]) {
            fetchMock
                .mockReset()
                .mockResolvedValueOnce(reply(401, { 'www-authenticate': 'Bearer realm="https://auth.ghcr.io/token"' }))
                .mockResolvedValueOnce(reply(200, {}, body));
            await expect(pingRegistry(OP, 'oci://ghcr.io/example', null)).rejects.toMatchObject({
                kind: 'unauthorized',
            });
        }
    });

    it('reports the credential as rejected when the token endpoint refuses it', async () => {
        fetchMock
            .mockResolvedValueOnce(reply(401, { 'www-authenticate': 'Bearer realm="https://auth.ghcr.io/token"' }))
            .mockResolvedValueOnce(reply(401));
        await expect(pingRegistry(OP, 'oci://ghcr.io/example', credential)).rejects.toMatchObject({
            kind: 'unauthorized',
            op: OP,
        });
    });

    it('reports a plain 401 with nothing to answer as a rejected credential', async () => {
        fetchMock.mockResolvedValue(reply(401));
        await expect(pingRegistry(OP, 'oci://ghcr.io/example', null)).rejects.toMatchObject({ kind: 'unauthorized' });
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('classifies the other answers a registry can give', async () => {
        for (const [status, kind] of [
            [403, 'forbidden'],
            [404, 'notFound'],
            [500, 'unknown'],
        ] as const) {
            fetchMock.mockReset().mockResolvedValue(reply(status));
            await expect(pingRegistry(OP, 'oci://ghcr.io/example', null)).rejects.toMatchObject({ kind });
        }
    });

    it('reports a registry that cannot be reached as unreachable', async () => {
        fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { code: 'ENOTFOUND' }));
        const error = await pingRegistry(OP, 'oci://ghcr.io/example', null).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(K8sError);
        expect(error).toMatchObject({ kind: 'unreachable', op: OP });
    });
});
