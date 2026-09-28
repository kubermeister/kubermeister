import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '../../../src/shared/settings';
import type { ChartRepository } from '../../../src/shared/charts';
import { MAX_ARCHIVE_BYTES } from '../../../src/main/charts/archive';
import { HELM_CHART_LAYER } from '../../../src/main/charts/oci';
import { nginxChart, sha256 } from './chart-archive-fixture';

let userData = '';
vi.mock('electron', () => ({ app: { getPath: () => userData } }));
const store = { getSettings: vi.fn(), updateSettings: vi.fn() };
vi.mock('../../../src/main/settings/store.js', () => store);
const credentials = {
    getCredential: vi.fn(),
    setCredential: vi.fn(),
    removeCredential: vi.fn(),
    hasCredential: vi.fn(),
};
vi.mock('../../../src/main/charts/credentials.js', () => credentials);

const { fetchChart } = await import('../../../src/main/charts/fetch.js');
const { removeChartRepository } = await import('../../../src/main/charts/repositories.js');
const { writeIndex } = await import('../../../src/main/charts/cache.js');

const OP = 'charts.fetch';
const classic: ChartRepository = { name: 'example', kind: 'classic', url: 'https://charts.example.com/stable' };
const oci: ChartRepository = { name: 'ghcr', kind: 'oci', url: 'oci://ghcr.io/example' };
const credential = { username: 'ara', password: 'hunter2' };
const basic = `Basic ${Buffer.from('ara:hunter2', 'utf8').toString('base64')}`;

const archive = nginxChart();
const digest = sha256(archive);

function indexYaml(urls: string[], entryDigest: string | null = digest, version = '1.0.0'): string {
    const digestLine = entryDigest ? `      digest: ${entryDigest}\n` : '';
    const urlLines = urls.map((url) => `        - ${url}\n`).join('');
    return `apiVersion: v1\nentries:\n  nginx:\n    - name: nginx\n      version: "${version}"\n${digestLine}      urls:\n${urlLines}`;
}

function reply(status: number, body: BodyInit | null = null, headers: Record<string, string> = {}): Response {
    return new Response(body, { status, headers });
}

const fetchMock = vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();

/** Serve these bodies by URL; anything else is a 404. */
function serve(routes: Record<string, () => Response>) {
    fetchMock.mockImplementation(async (url) => (routes[String(url)] ?? (() => reply(404)))());
}

const requested = () => fetchMock.mock.calls.map(([url]) => String(url));
const headersOf = (call: number) => (fetchMock.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;
const cacheDir = (name: string) => join(userData, 'chart-cache', name);

describe('fetchChart', () => {
    beforeEach(() => {
        userData = mkdtempSync(join(tmpdir(), 'km-charts-fetch-'));
        vi.clearAllMocks();
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
        store.getSettings.mockReturnValue(
            mergeSettings(DEFAULT_SETTINGS, { charts: { repositories: [classic, oci] } }),
        );
        store.updateSettings.mockImplementation((patch) => mergeSettings(store.getSettings(), patch));
        credentials.getCredential.mockReturnValue(null);
        credentials.hasCredential.mockReturnValue(false);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        rmSync(userData, { recursive: true, force: true });
    });

    describe('from a classic repository', () => {
        it('downloads the version its index lists, relative to the repository, and caches it by digest', async () => {
            serve({
                'https://charts.example.com/stable/index.yaml': () => reply(200, indexYaml(['nginx-1.0.0.tgz'])),
                'https://charts.example.com/stable/nginx-1.0.0.tgz': () => reply(200, archive),
            });
            const fetched = await fetchChart('example', 'nginx', '1.0.0');
            expect(requested()).toEqual([
                'https://charts.example.com/stable/index.yaml',
                'https://charts.example.com/stable/nginx-1.0.0.tgz',
            ]);
            expect(fetched).toMatchObject({
                digest,
                path: join(cacheDir('example'), `${digest}.tgz`),
                valuesYaml: '# How many pods\nreplicaCount: 1\n',
                valuesSchema: '{"type":"object"}',
            });
            expect(fetched.chartYaml).toContain('name: nginx');
            expect(readFileSync(fetched.path).equals(archive)).toBe(true);
        });

        it('answers a second fetch of the same version from the cache without touching the network', async () => {
            serve({
                'https://charts.example.com/stable/index.yaml': () => reply(200, indexYaml(['nginx-1.0.0.tgz'])),
                'https://charts.example.com/stable/nginx-1.0.0.tgz': () => reply(200, archive),
            });
            const first = await fetchChart('example', 'nginx', '1.0.0');
            fetchMock.mockClear();
            await expect(fetchChart('example', 'nginx', '1.0.0')).resolves.toEqual(first);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('downloads again when the cached file no longer hashes to its digest', async () => {
            serve({
                'https://charts.example.com/stable/index.yaml': () => reply(200, indexYaml(['nginx-1.0.0.tgz'])),
                'https://charts.example.com/stable/nginx-1.0.0.tgz': () => reply(200, archive),
            });
            const { path } = await fetchChart('example', 'nginx', '1.0.0');
            writeFileSync(path, 'truncated');
            fetchMock.mockClear();
            await fetchChart('example', 'nginx', '1.0.0');
            expect(requested()).toEqual(['https://charts.example.com/stable/nginx-1.0.0.tgz']);
            expect(readFileSync(path).equals(archive)).toBe(true);
        });

        it('refuses an archive that does not match the digest its index lists, and caches nothing', async () => {
            serve({
                'https://charts.example.com/stable/index.yaml': () =>
                    reply(200, indexYaml(['nginx-1.0.0.tgz'], 'f'.repeat(64))),
                'https://charts.example.com/stable/nginx-1.0.0.tgz': () => reply(200, archive),
            });
            await expect(fetchChart('example', 'nginx', '1.0.0')).rejects.toMatchObject({
                kind: 'invalid',
                op: OP,
                detail: expect.stringMatching(/digest/),
            });
            expect(existsSync(cacheDir('example'))).toBe(false);
        });

        it('tries the next URL the index lists when one fails, and reports the last reason when all do', async () => {
            serve({
                'https://charts.example.com/stable/index.yaml': () =>
                    reply(200, indexYaml(['https://mirror.example.com/nginx-1.0.0.tgz', 'nginx-1.0.0.tgz'])),
                'https://charts.example.com/stable/nginx-1.0.0.tgz': () => reply(200, archive),
            });
            await expect(fetchChart('example', 'nginx', '1.0.0')).resolves.toMatchObject({ digest });

            rmSync(cacheDir('example'), { recursive: true });
            serve({ 'https://charts.example.com/stable/nginx-1.0.0.tgz': () => reply(403) });
            await expect(fetchChart('example', 'nginx', '1.0.0')).rejects.toMatchObject({ kind: 'forbidden' });
        });

        it("sends the repository's credential to its own origin and to no other host the index names", async () => {
            credentials.getCredential.mockReturnValue(credential);
            serve({
                'https://charts.example.com/stable/index.yaml': () =>
                    reply(200, indexYaml(['https://cdn.example.net/nginx-1.0.0.tgz', 'nginx-1.0.0.tgz'])),
                'https://cdn.example.net/nginx-1.0.0.tgz': () => reply(500),
                'https://charts.example.com/stable/nginx-1.0.0.tgz': () => reply(200, archive),
            });
            await fetchChart('example', 'nginx', '1.0.0');
            expect(headersOf(0).authorization).toBe(basic);
            expect(headersOf(1).authorization).toBeUndefined();
            expect(headersOf(2).authorization).toBe(basic);
        });

        it('never downloads from an address that is not http or https', async () => {
            serve({
                'https://charts.example.com/stable/index.yaml': () => reply(200, indexYaml(['file:///etc/passwd'])),
            });
            await expect(fetchChart('example', 'nginx', '1.0.0')).rejects.toMatchObject({ kind: 'invalid' });
            expect(requested()).toEqual(['https://charts.example.com/stable/index.yaml']);
        });

        it('accepts an index entry with no digest, keying the cache by what the archive hashes to', async () => {
            serve({
                'https://charts.example.com/stable/index.yaml': () => reply(200, indexYaml(['nginx-1.0.0.tgz'], null)),
                'https://charts.example.com/stable/nginx-1.0.0.tgz': () => reply(200, archive),
            });
            await expect(fetchChart('example', 'nginx', '1.0.0')).resolves.toMatchObject({ digest });
        });

        it('refreshes a cached index that does not list the version, a version published since', async () => {
            writeIndex('example', {
                url: classic.url,
                refreshedAt: '2026-09-01T00:00:00.000Z',
                charts: [],
                archives: {},
            });
            serve({
                'https://charts.example.com/stable/index.yaml': () => reply(200, indexYaml(['nginx-1.0.0.tgz'])),
                'https://charts.example.com/stable/nginx-1.0.0.tgz': () => reply(200, archive),
            });
            await expect(fetchChart('example', 'nginx', '1.0.0')).resolves.toMatchObject({ digest });
            expect(requested()).toEqual([
                'https://charts.example.com/stable/index.yaml',
                'https://charts.example.com/stable/nginx-1.0.0.tgz',
            ]);
        });

        it('reports a version the refreshed index does not list either as missing, after one refresh', async () => {
            serve({
                'https://charts.example.com/stable/index.yaml': () =>
                    reply(200, indexYaml(['nginx-0.9.0.tgz'], digest, '0.9.0')),
            });
            await expect(fetchChart('example', 'nginx', '1.0.0')).rejects.toMatchObject({
                kind: 'notFound',
                detail: 'nginx 1.0.0 is not in example.',
            });
            expect(requested()).toEqual(['https://charts.example.com/stable/index.yaml']);
        });

        it('refuses an archive past the ceiling without reading all of it', async () => {
            serve({
                'https://charts.example.com/stable/index.yaml': () => reply(200, indexYaml(['nginx-1.0.0.tgz'])),
                'https://charts.example.com/stable/nginx-1.0.0.tgz': () =>
                    reply(200, 'x', { 'content-length': String(MAX_ARCHIVE_BYTES + 1) }),
            });
            await expect(fetchChart('example', 'nginx', '1.0.0')).rejects.toMatchObject({
                kind: 'invalid',
                detail: expect.stringMatching(/larger than/),
            });
        });

        it('never caches an archive holding an unsafe entry, even one matching its digest', async () => {
            const unsafe = nginxChart([{ name: 'nginx/../../.ssh/authorized_keys', body: 'key' }]);
            serve({
                'https://charts.example.com/stable/index.yaml': () =>
                    reply(200, indexYaml(['nginx-1.0.0.tgz'], sha256(unsafe))),
                'https://charts.example.com/stable/nginx-1.0.0.tgz': () => reply(200, unsafe),
            });
            await expect(fetchChart('example', 'nginx', '1.0.0')).rejects.toMatchObject({
                kind: 'invalid',
                detail: expect.stringMatching(/unsafe/),
            });
            expect(existsSync(cacheDir('example'))).toBe(false);
        });

        it('refuses an archive that is some other chart or version than the one asked for', async () => {
            const other = nginxChart([], 'apiVersion: v2\nname: redis\nversion: 1.0.0\n');
            serve({
                'https://charts.example.com/stable/index.yaml': () =>
                    reply(200, indexYaml(['nginx-1.0.0.tgz'], sha256(other))),
                'https://charts.example.com/stable/nginx-1.0.0.tgz': () => reply(200, other),
            });
            await expect(fetchChart('example', 'nginx', '1.0.0')).rejects.toMatchObject({
                kind: 'invalid',
                detail: 'The archive holds redis 1.0.0, not nginx 1.0.0.',
            });
        });
    });

    describe('from an OCI registry', () => {
        const manifestUrl = 'https://ghcr.io/v2/example/nginx/manifests/1.0.0';
        const blobUrl = `https://ghcr.io/v2/example/nginx/blobs/sha256:${digest}`;
        const manifest = (layerDigest = digest, size = archive.length) =>
            JSON.stringify({
                schemaVersion: 2,
                config: { mediaType: 'application/vnd.cncf.helm.config.v1+json' },
                layers: [{ mediaType: HELM_CHART_LAYER, digest: `sha256:${layerDigest}`, size }],
            });
        const challenge = () =>
            reply(401, null, {
                'www-authenticate':
                    'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:example/nginx:pull"',
            });

        it('reads the manifest, answers the challenge for its scope once and downloads the chart layer', async () => {
            credentials.getCredential.mockReturnValue(credential);
            let manifestAsks = 0;
            serve({
                [manifestUrl]: () => (manifestAsks++ === 0 ? challenge() : reply(200, manifest())),
                'https://ghcr.io/token?service=ghcr.io&scope=repository%3Aexample%2Fnginx%3Apull': () =>
                    reply(200, JSON.stringify({ token: 'pull-token' })),
                [blobUrl]: () => reply(200, archive),
            });
            const fetched = await fetchChart('ghcr', 'nginx', '1.0.0');
            expect(fetched).toMatchObject({ digest, path: join(cacheDir('ghcr'), `${digest}.tgz`) });
            expect(requested()).toEqual([
                manifestUrl,
                'https://ghcr.io/token?service=ghcr.io&scope=repository%3Aexample%2Fnginx%3Apull',
                manifestUrl,
                blobUrl,
            ]);
            expect(headersOf(0)).toMatchObject({
                authorization: basic,
                accept: expect.stringContaining('oci.image.manifest'),
            });
            expect(headersOf(1).authorization).toBe(basic);
            expect(headersOf(2).authorization).toBe('Bearer pull-token');
            // The token is kept for the blob rather than asked for again.
            expect(headersOf(3).authorization).toBe('Bearer pull-token');
        });

        it('asks for the manifest again, since a tag can move, but answers its layer from the cache', async () => {
            serve({ [manifestUrl]: () => reply(200, manifest()), [blobUrl]: () => reply(200, archive) });
            await fetchChart('ghcr', 'nginx', '1.0.0');
            fetchMock.mockClear();
            await fetchChart('ghcr', 'nginx', '1.0.0');
            expect(requested()).toEqual([manifestUrl]);
        });

        it('says the version is not there when the registry has no such tag', async () => {
            serve({});
            await expect(fetchChart('ghcr', 'nginx', '1.0.0')).rejects.toMatchObject({
                kind: 'notFound',
                detail: 'nginx 1.0.0 is not in ghcr.',
            });
        });

        it('refuses a manifest that is not JSON or names no chart layer', async () => {
            serve({ [manifestUrl]: () => reply(200, '<html>') });
            await expect(fetchChart('ghcr', 'nginx', '1.0.0')).rejects.toMatchObject({ kind: 'invalid' });
            serve({ [manifestUrl]: () => reply(200, JSON.stringify({ schemaVersion: 2, layers: [] })) });
            await expect(fetchChart('ghcr', 'nginx', '1.0.0')).rejects.toMatchObject({
                kind: 'invalid',
                detail: expect.stringMatching(/other than a Helm chart/),
            });
        });

        it('refuses a layer larger than the ceiling before downloading it', async () => {
            serve({ [manifestUrl]: () => reply(200, manifest(digest, MAX_ARCHIVE_BYTES + 1)) });
            await expect(fetchChart('ghcr', 'nginx', '1.0.0')).rejects.toMatchObject({
                kind: 'invalid',
                detail: expect.stringMatching(/larger than/),
            });
            expect(requested()).toEqual([manifestUrl]);
        });

        it('refuses a blob that does not hash to the digest its manifest names', async () => {
            const other = 'e'.repeat(64);
            serve({
                [manifestUrl]: () => reply(200, manifest(other)),
                [`https://ghcr.io/v2/example/nginx/blobs/sha256:${other}`]: () => reply(200, archive),
            });
            await expect(fetchChart('ghcr', 'nginx', '1.0.0')).rejects.toMatchObject({
                kind: 'invalid',
                detail: expect.stringMatching(/digest/),
            });
            expect(existsSync(cacheDir('ghcr'))).toBe(false);
        });

        it('classifies a registry that refuses the credential', async () => {
            serve({ [manifestUrl]: () => reply(401) });
            await expect(fetchChart('ghcr', 'nginx', '1.0.0')).rejects.toMatchObject({ kind: 'unauthorized', op: OP });
        });
    });

    it('refuses a chart name or version that could not be a path segment, before any request', async () => {
        await expect(fetchChart('example', '../nginx', '1.0.0')).rejects.toMatchObject({ kind: 'invalid' });
        await expect(fetchChart('example', 'nginx', '1.0.0/../x')).rejects.toMatchObject({ kind: 'invalid' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('says so for a source nobody configured', async () => {
        await expect(fetchChart('nope', 'nginx', '1.0.0')).rejects.toMatchObject({ kind: 'notFound', op: OP });
    });

    it('leaves nothing of a repository behind once it is removed', async () => {
        serve({
            'https://charts.example.com/stable/index.yaml': () => reply(200, indexYaml(['nginx-1.0.0.tgz'])),
            'https://charts.example.com/stable/nginx-1.0.0.tgz': () => reply(200, archive),
        });
        await fetchChart('example', 'nginx', '1.0.0');
        await removeChartRepository('example');
        expect(existsSync(cacheDir('example'))).toBe(false);
        expect(readdirSync(join(userData, 'chart-index'))).toEqual([]);
    });
});
