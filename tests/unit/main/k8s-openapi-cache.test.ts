import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userData = '';
vi.mock('electron', () => ({ app: { getPath: () => userData } }));

const { documentFile, readCachedDocument, writeCachedDocument } =
    await import('../../../src/main/k8s/openapi/cache.js');

const PATH = 'apis/apps/v1';
const DEFINITIONS = { 'io.k8s.api.apps.v1.Deployment': { type: 'object', description: 'A deployment.' } };

describe('the OpenAPI document cache', () => {
    beforeEach(() => {
        userData = mkdtempSync(join(tmpdir(), 'km-openapi-'));
    });

    afterEach(() => {
        rmSync(userData, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('reads back what it wrote for the same context, document and hash', () => {
        writeCachedDocument('alpha', PATH, 'H1', DEFINITIONS);
        expect(readCachedDocument('alpha', PATH, 'H1')).toEqual(DEFINITIONS);
    });

    it('misses on a hash the cluster has moved on from, and replaces the copy it had', () => {
        writeCachedDocument('alpha', PATH, 'H1', DEFINITIONS);
        expect(readCachedDocument('alpha', PATH, 'H2')).toBeNull();
        writeCachedDocument('alpha', PATH, 'H2', DEFINITIONS);
        expect(readCachedDocument('alpha', PATH, 'H1')).toBeNull();
        expect(readdirSync(dirname(documentFile('alpha', PATH, 'H2')))).toEqual([
            basename(documentFile('alpha', PATH, 'H2')),
        ]);
    });

    it('keeps another document of the same context, which has a hash of its own', () => {
        writeCachedDocument('alpha', PATH, 'H1', DEFINITIONS);
        writeCachedDocument('alpha', 'api/v1', 'H9', { 'io.k8s.api.core.v1.Pod': { type: 'object' } });
        writeCachedDocument('alpha', PATH, 'H2', DEFINITIONS);
        expect(readCachedDocument('alpha', 'api/v1', 'H9')).toEqual({ 'io.k8s.api.core.v1.Pod': { type: 'object' } });
    });

    it('keeps each context apart, since a document is only ever true of the cluster it came from', () => {
        writeCachedDocument('alpha', PATH, 'H1', DEFINITIONS);
        writeCachedDocument('beta', PATH, 'H1', { 'io.k8s.api.apps.v1.Deployment': { type: 'string' } });
        expect(readCachedDocument('alpha', PATH, 'H1')).toEqual(DEFINITIONS);
        expect(readCachedDocument('beta', PATH, 'H1')).toEqual({ 'io.k8s.api.apps.v1.Deployment': { type: 'string' } });
    });

    it('files a context whose name no directory could hold', () => {
        const context = 'arn:aws:eks:eu-west-1:1234:cluster/prod';
        writeCachedDocument(context, PATH, 'H1', DEFINITIONS);
        expect(readCachedDocument(context, PATH, 'H1')).toEqual(DEFINITIONS);
        expect(documentFile(context, PATH, 'H1')).not.toContain(':');
        expect(basename(documentFile(context, 'apis/example.com/v1', 'H1'))).toMatch(/^apis_example\.com_v1\./);
    });

    it('reads a missing, corrupt or rewritten file as a miss rather than as a schema', () => {
        expect(readCachedDocument('alpha', PATH, 'H1')).toBeNull();
        writeCachedDocument('alpha', PATH, 'H1', DEFINITIONS);
        writeFileSync(documentFile('alpha', PATH, 'H1'), '{ not json');
        expect(readCachedDocument('alpha', PATH, 'H1')).toBeNull();
        writeFileSync(documentFile('alpha', PATH, 'H1'), '["a definition map is not a list"]');
        expect(readCachedDocument('alpha', PATH, 'H1')).toBeNull();
    });

    it('normalises what it reads, so a hand-edited file cannot hand the editor a shape it trusts', () => {
        writeCachedDocument('alpha', PATH, 'H1', DEFINITIONS);
        writeFileSync(documentFile('alpha', PATH, 'H1'), JSON.stringify({ A: { type: 'object', example: 'gone' } }));
        expect(readCachedDocument('alpha', PATH, 'H1')).toEqual({ A: { type: 'object' } });
    });

    it('writes atomically and survives a write it cannot make', () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        writeCachedDocument('alpha', PATH, 'H1', DEFINITIONS);
        const file = documentFile('alpha', PATH, 'H1');
        expect(readdirSync(dirname(file)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(DEFINITIONS);

        rmSync(userData, { recursive: true, force: true });
        writeFileSync(userData, 'a file where the directory should be');
        expect(() => writeCachedDocument('alpha', PATH, 'H2', DEFINITIONS)).not.toThrow();
        expect(readCachedDocument('alpha', PATH, 'H2')).toBeNull();
        expect(logged).toHaveBeenCalled();
    });
});
