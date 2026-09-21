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
