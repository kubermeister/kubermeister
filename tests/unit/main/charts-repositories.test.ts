import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '../../../src/shared/settings';
import type { ChartRepository } from '../../../src/shared/charts';

const store = { getSettings: vi.fn(), updateSettings: vi.fn() };
const credentials = {
    getCredential: vi.fn(),
    setCredential: vi.fn(),
    removeCredential: vi.fn(),
    hasCredential: vi.fn(),
};
const cache = { readIndex: vi.fn(), writeIndex: vi.fn(), removeIndex: vi.fn() };
const registry = { pingRegistry: vi.fn() };
vi.mock('../../../src/main/settings/store.js', () => store);
vi.mock('../../../src/main/charts/credentials.js', () => credentials);
vi.mock('../../../src/main/charts/cache.js', () => cache);
// Only the network call is stood in for: the header and status helpers beside it are the real ones,
// so what this module actually sends is asserted rather than described twice.
vi.mock('../../../src/main/charts/registry.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/main/charts/registry.js')>()),
    ...registry,
}));

const { addChartRepository, listChartRepositories, refreshChartRepository, removeChartRepository } =
    await import('../../../src/main/charts/repositories.js');

const bitnami: ChartRepository = { name: 'bitnami', kind: 'classic', url: 'https://charts.example.com' };
const ghcr: ChartRepository = { name: 'ghcr', kind: 'oci', url: 'oci://ghcr.io/example' };

const INDEX_YAML = `apiVersion: v1
entries:
  nginx:
    - name: nginx
      version: "18.2.0"
      appVersion: "1.27.1"
      description: A web server
  redis:
    - name: redis
      version: "20.0.1"
      appVersion: "7.4.0"
`;

const fetchMock = vi.fn();

function settingsWith(repositories: ChartRepository[]) {
    return mergeSettings(DEFAULT_SETTINGS, { charts: { repositories } });
}

/** The settings the store would hold after the patch the call under test wrote. */
function persisted(): ChartRepository[] {
    const patch = store.updateSettings.mock.calls.at(-1)?.[0] as { charts?: { repositories: ChartRepository[] } };
    return patch.charts?.repositories ?? [];
}

function okIndex(body = INDEX_YAML): Response {
    return new Response(body, { status: 200 });
}

describe('chart repositories', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', fetchMock);
        store.getSettings.mockReturnValue(settingsWith([]));
        store.updateSettings.mockImplementation((patch) => mergeSettings(store.getSettings(), patch));
        credentials.hasCredential.mockReturnValue(false);
        credentials.getCredential.mockReturnValue(null);
        cache.readIndex.mockReturnValue(null);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe('listChartRepositories', () => {
        it('is empty until a repository is added', async () => {
            await expect(listChartRepositories()).resolves.toEqual([]);
        });

        it('reports each repository over what the cache and the keychain hold for it', async () => {
            store.getSettings.mockReturnValue(settingsWith([bitnami, ghcr]));
            cache.readIndex.mockImplementation((name: string) =>
                name === 'bitnami'
                    ? { url: bitnami.url, refreshedAt: '2026-09-22T10:00:00.000Z', charts: [{}, {}, {}] }
                    : null,
            );
            credentials.hasCredential.mockImplementation((name: string) => name === 'ghcr');
            await expect(listChartRepositories()).resolves.toEqual([
                {
                    ...bitnami,
                    hasCredentials: false,
                    chartCount: 3,
                    refreshedAt: '2026-09-22T10:00:00.000Z',
                },
                { ...ghcr, hasCredentials: true, chartCount: null, refreshedAt: null },
            ]);
            // The cache is only trusted for the URL the repository still points at.
            expect(cache.readIndex).toHaveBeenCalledWith('bitnami', bitnami.url);
        });
    });

    describe('addChartRepository', () => {
        it('fetches the index, caches it and only then records the repository', async () => {
            fetchMock.mockResolvedValue(okIndex());
            const added = await addChartRepository(bitnami);
            expect(fetchMock.mock.calls[0][0]).toBe('https://charts.example.com/index.yaml');
            const [name, index] = cache.writeIndex.mock.calls[0] as [string, { charts: unknown[]; url: string }];
            expect(name).toBe('bitnami');
            expect(index.url).toBe(bitnami.url);
            expect(index.charts).toHaveLength(2);
            expect(persisted()).toEqual([bitnami]);
            expect(added).toMatchObject({ ...bitnami, chartCount: 2, hasCredentials: false });
            expect(added.refreshedAt).toEqual(expect.any(String));
        });

        it('stores the credential in the keychain and sends it with the index request', async () => {
            fetchMock.mockResolvedValue(okIndex());
            credentials.getCredential.mockReturnValue({ username: 'ara', password: 'hunter2' });
            credentials.hasCredential.mockReturnValue(true);
            const added = await addChartRepository({ ...bitnami, username: 'ara', password: 'hunter2' });
            expect(credentials.setCredential).toHaveBeenCalledWith(
                'bitnami',
                { username: 'ara', password: 'hunter2' },
                'chartRepositories.add',
            );
            const init = fetchMock.mock.calls[0][1] as RequestInit;
            expect((init.headers as Record<string, string>).authorization).toBe(
                `Basic ${Buffer.from('ara:hunter2', 'utf8').toString('base64')}`,
            );
            expect(added.hasCredentials).toBe(true);
            // The password is answered back only as the fact that one is held.
            expect(added).not.toHaveProperty('password');
        });

        it('pings an OCI registry instead, since a registry publishes no index to cache', async () => {
            registry.pingRegistry.mockResolvedValue(undefined);
            const added = await addChartRepository(ghcr);
            expect(registry.pingRegistry).toHaveBeenCalledWith('chartRepositories.add', ghcr.url, null);
            expect(fetchMock).not.toHaveBeenCalled();
            // The cache file is still written: it is also what records when the source last answered.
            expect(cache.writeIndex).toHaveBeenCalledWith('ghcr', expect.objectContaining({ charts: [] }));
            expect(added).toMatchObject({ ...ghcr, chartCount: null });
            expect(added.refreshedAt).toEqual(expect.any(String));
        });

        it('refuses a name another repository already uses', async () => {
            store.getSettings.mockReturnValue(settingsWith([bitnami]));
            await expect(addChartRepository({ ...bitnami, url: 'https://other.example.com' })).rejects.toMatchObject({
                kind: 'conflict',
                op: 'chartRepositories.add',
            });
            expect(store.updateSettings).not.toHaveBeenCalled();
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('refuses to grow the list past what the settings file holds', async () => {
            const many = Array.from({ length: 50 }, (_, i) => ({ ...bitnami, name: `repo-${i}` }));
            store.getSettings.mockReturnValue(settingsWith(many));
            await expect(addChartRepository(bitnami)).rejects.toMatchObject({ kind: 'invalid' });
            expect(store.updateSettings).not.toHaveBeenCalled();
        });

        it('records nothing and forgets the credential again when the source does not answer', async () => {
            fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' }));
            await expect(
                addChartRepository({ ...bitnami, username: 'ara', password: 'hunter2' }),
            ).rejects.toMatchObject({ kind: 'unreachable' });
            expect(store.updateSettings).not.toHaveBeenCalled();
            expect(cache.writeIndex).not.toHaveBeenCalled();
            expect(credentials.removeCredential).toHaveBeenCalledWith('bitnami', 'chartRepositories.add');
        });

        it('leaves the keychain alone when a failed add had no credential to store', async () => {
            registry.pingRegistry.mockRejectedValue(new Error('boom'));
            await expect(addChartRepository(ghcr)).rejects.toMatchObject({ kind: 'unknown' });
            expect(credentials.removeCredential).not.toHaveBeenCalled();
            expect(store.updateSettings).not.toHaveBeenCalled();
        });

        it('reports the answers a repository can give instead of caching them', async () => {
            for (const [status, kind] of [
                [401, 'unauthorized'],
                [403, 'forbidden'],
                [404, 'notFound'],
                [500, 'unknown'],
            ] as const) {
                fetchMock.mockReset().mockResolvedValue(new Response('', { status }));
                await expect(addChartRepository(bitnami)).rejects.toMatchObject({ kind });
            }
            expect(cache.writeIndex).not.toHaveBeenCalled();
            expect(store.updateSettings).not.toHaveBeenCalled();
        });

        it('refuses an index larger than any real one rather than holding it in memory', async () => {
            fetchMock.mockResolvedValue(
                new Response('entries: {}', { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } }),
            );
            await expect(addChartRepository(bitnami)).rejects.toMatchObject({ kind: 'invalid' });
            expect(cache.writeIndex).not.toHaveBeenCalled();
        });

        it('refuses an answer that is not an index at all, parseable as YAML or not', async () => {
            for (const body of ['<html>404</html>', 'entries:\n  - [unclosed']) {
                fetchMock.mockReset().mockResolvedValue(new Response(body, { status: 200 }));
                await expect(addChartRepository(bitnami), body).rejects.toMatchObject({ kind: 'invalid' });
            }
            expect(store.updateSettings).not.toHaveBeenCalled();
        });
    });

    describe('refreshChartRepository', () => {
        it('reads the index again and rewrites the cache', async () => {
            store.getSettings.mockReturnValue(settingsWith([bitnami]));
            fetchMock.mockResolvedValue(okIndex());
            const refreshed = await refreshChartRepository('bitnami');
            expect(cache.writeIndex).toHaveBeenCalledOnce();
            expect(refreshed.chartCount).toBe(2);
            // A refresh changes nothing about which repositories exist.
            expect(store.updateSettings).not.toHaveBeenCalled();
        });

        it('sends the stored credential, which the user never types again', async () => {
            store.getSettings.mockReturnValue(settingsWith([bitnami]));
            credentials.getCredential.mockReturnValue({ username: 'ara', password: 'hunter2' });
            fetchMock.mockResolvedValue(okIndex());
            await refreshChartRepository('bitnami');
            expect(credentials.getCredential).toHaveBeenCalledWith('bitnami');
            const init = fetchMock.mock.calls[0][1] as RequestInit;
            expect((init.headers as Record<string, string>).authorization).toContain('Basic ');
        });

        it('has nothing to refresh for a repository that is not configured', async () => {
            await expect(refreshChartRepository('bitnami')).rejects.toMatchObject({
                kind: 'notFound',
                op: 'chartRepositories.refresh',
            });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('leaves the last good cache in place when the refresh fails', async () => {
            store.getSettings.mockReturnValue(settingsWith([bitnami]));
            fetchMock.mockResolvedValue(new Response('', { status: 500 }));
            await expect(refreshChartRepository('bitnami')).rejects.toBeTruthy();
            expect(cache.writeIndex).not.toHaveBeenCalled();
            expect(cache.removeIndex).not.toHaveBeenCalled();
        });
    });

    describe('removeChartRepository', () => {
        it('drops the repository, its cached index and its credential together', async () => {
            store.getSettings.mockReturnValue(settingsWith([bitnami, ghcr]));
            await expect(removeChartRepository('bitnami')).resolves.toEqual({ name: 'bitnami' });
            expect(persisted()).toEqual([ghcr]);
            expect(cache.removeIndex).toHaveBeenCalledWith('bitnami');
            expect(credentials.removeCredential).toHaveBeenCalledWith('bitnami', 'chartRepositories.remove');
        });

        it('has nothing to remove for a repository that is not configured', async () => {
            await expect(removeChartRepository('bitnami')).rejects.toMatchObject({
                kind: 'notFound',
                op: 'chartRepositories.remove',
            });
            expect(store.updateSettings).not.toHaveBeenCalled();
            expect(cache.removeIndex).not.toHaveBeenCalled();
        });
    });
});
