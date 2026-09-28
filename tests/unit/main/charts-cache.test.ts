import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartIndex } from '../../../src/shared/charts';

let userData = '';
vi.mock('electron', () => ({ app: { getPath: () => userData } }));

async function loadCache() {
    vi.resetModules();
    return import('../../../src/main/charts/cache.js');
}

const index: ChartIndex = {
    url: 'https://charts.example.com',
    refreshedAt: '2026-09-22T10:00:00.000Z',
    charts: [{ name: 'nginx', latestVersion: '1.0.0', appVersion: '1.27', description: 'x', versions: ['1.0.0'] }],
    archives: { nginx: { '1.0.0': { urls: ['nginx-1.0.0.tgz'], digest: 'a'.repeat(64) } } },
};

const cacheFile = (name: string) => join(userData, 'chart-index', `${name}.json`);

describe('chart index cache', () => {
    beforeEach(() => {
        userData = mkdtempSync(join(tmpdir(), 'km-charts-cache-'));
    });

    afterEach(() => {
        rmSync(userData, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('writes an index and reads it back', async () => {
        const { readIndex, writeIndex } = await loadCache();
        writeIndex('bitnami', index);
        expect(existsSync(cacheFile('bitnami'))).toBe(true);
        expect(readIndex('bitnami', index.url)).toEqual(index);
    });

    it('has nothing for a repository that has never refreshed', async () => {
        const { readIndex } = await loadCache();
        expect(readIndex('bitnami', index.url)).toBeNull();
    });

    it('reads an index cached before archives were recorded as one that lists none', async () => {
        const { readIndex } = await loadCache();
        mkdirSync(join(userData, 'chart-index'), { recursive: true });
        const { archives: _archives, ...older } = index;
        writeFileSync(cacheFile('bitnami'), JSON.stringify(older));
        expect(readIndex('bitnami', index.url)).toEqual({ ...older, archives: {} });
    });

    it('ignores a cache file left over from a different URL, which is no longer this repository', async () => {
        const { readIndex, writeIndex } = await loadCache();
        writeIndex('bitnami', index);
        expect(readIndex('bitnami', 'https://charts.other.com')).toBeNull();
    });

    it('ignores a corrupt or unrecognisable cache file rather than failing the list', async () => {
        const { readIndex } = await loadCache();
        mkdirSync(join(userData, 'chart-index'), { recursive: true });
        writeFileSync(cacheFile('bitnami'), '{ not json');
        expect(readIndex('bitnami', index.url)).toBeNull();
        writeFileSync(cacheFile('bitnami'), JSON.stringify({ url: index.url, charts: 'lots' }));
        expect(readIndex('bitnami', index.url)).toBeNull();
    });

    it('forgets an index, and forgetting one that is not there is not an error', async () => {
        const { readIndex, removeIndex, writeIndex } = await loadCache();
        writeIndex('bitnami', index);
        removeIndex('bitnami');
        expect(existsSync(cacheFile('bitnami'))).toBe(false);
        expect(readIndex('bitnami', index.url)).toBeNull();
        expect(() => removeIndex('bitnami')).not.toThrow();
    });

    it('refuses a name that is not a repository name, so no cache path can escape its directory', async () => {
        const { readIndex, removeIndex, writeIndex } = await loadCache();
        for (const name of ['../escape', 'a/b', '', 'UPPER']) {
            expect(() => writeIndex(name, index), name).toThrow();
            expect(() => removeIndex(name), name).toThrow();
            expect(() => readIndex(name, index.url), name).toThrow();
        }
    });

    it('survives a write failure without throwing, since the index is only a cache', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        rmSync(userData, { recursive: true, force: true });
        writeFileSync(userData, 'not a directory');
        const { writeIndex } = await loadCache();
        expect(() => writeIndex('bitnami', index)).not.toThrow();
        expect(logged).toHaveBeenCalledOnce();
    });
});

describe('chart archive cache', () => {
    const bytes = Buffer.from('an archive');
    const digest = createHash('sha256').update(bytes).digest('hex');

    beforeEach(() => {
        userData = mkdtempSync(join(tmpdir(), 'km-charts-archives-'));
    });

    afterEach(() => {
        rmSync(userData, { recursive: true, force: true });
    });

    it('keeps an archive under its repository, named by its digest, and reads it back', async () => {
        const { readArchive, writeArchive } = await loadCache();
        const path = writeArchive('bitnami', digest, bytes);
        expect(path).toBe(join(userData, 'chart-cache', 'bitnami', `${digest}.tgz`));
        expect(readArchive('bitnami', digest)?.equals(bytes)).toBe(true);
        // Another repository's cache is its own, even for the same bytes.
        expect(readArchive('other', digest)).toBeNull();
    });

    it('reads a file that no longer hashes to its name as a miss', async () => {
        const { archivePath, readArchive, writeArchive } = await loadCache();
        writeArchive('bitnami', digest, bytes);
        writeFileSync(archivePath('bitnami', digest), 'cut short');
        expect(readArchive('bitnami', digest)).toBeNull();
    });

    it('removes every archive of a repository, and removing none is not an error', async () => {
        const { readArchive, removeArchives, writeArchive } = await loadCache();
        writeArchive('bitnami', digest, bytes);
        writeArchive('other', digest, bytes);
        removeArchives('bitnami');
        expect(existsSync(join(userData, 'chart-cache', 'bitnami'))).toBe(false);
        expect(readArchive('other', digest)).not.toBeNull();
        expect(() => removeArchives('bitnami')).not.toThrow();
    });

    it('refuses a name or a digest that could make a path outside the cache', async () => {
        const { archivePath, removeArchives } = await loadCache();
        expect(() => archivePath('../escape', digest)).toThrow();
        expect(() => removeArchives('../escape')).toThrow();
        for (const bad of ['../x', 'A'.repeat(64), 'a'.repeat(63), `sha256:${digest}`]) {
            expect(() => archivePath('bitnami', bad), bad).toThrow();
        }
    });
});
