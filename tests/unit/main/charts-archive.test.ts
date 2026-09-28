import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
    entryPathProblem,
    MAX_EXPANDED_BYTES,
    readChartArchive,
    readTarEntries,
} from '../../../src/main/charts/archive';
import { gzipOf, NGINX_CHART_YAML, nginxChart, tarOf } from './chart-archive-fixture';

const OP = 'charts.fetch';

describe('entryPathProblem', () => {
    it('accepts a path inside the chart', () => {
        expect(entryPathProblem('nginx/templates/deployment.yaml')).toBeNull();
        expect(entryPathProblem('nginx/files/..hidden')).toBeNull();
    });

    it('refuses an absolute path, a drive letter and a parent reference, whichever separator is used', () => {
        for (const name of ['/etc/passwd', 'C:/Windows/x', 'c:\\x', 'nginx/../../x', '..', 'nginx\\..\\..\\x']) {
            expect(entryPathProblem(name), name).not.toBeNull();
        }
    });
});

describe('readTarEntries', () => {
    it('joins the ustar prefix onto the name and reads long names from pax and GNU headers', () => {
        const long = `nginx/${'a'.repeat(120)}.yaml`;
        const entries = readTarEntries(
            OP,
            tarOf([
                { name: 'deployment.yaml', prefix: 'nginx/templates' },
                { name: 'truncated', paxPath: long },
                { name: 'truncated', gnuLongName: `${long}.gnu` },
                { name: 'nginx/after.yaml' },
            ]),
        );
        expect(entries.map((entry) => entry.name)).toEqual([
            'nginx/templates/deployment.yaml',
            long,
            `${long}.gnu`,
            // A long name belongs to the one entry after it and no other.
            'nginx/after.yaml',
        ]);
    });

    it('refuses bytes that are not a tar, and a tar cut short', () => {
        expect(() => readTarEntries(OP, Buffer.alloc(512, 'x'))).toThrow(/not a tar/);
        const tar = tarOf([{ name: 'nginx/Chart.yaml', body: 'x'.repeat(2000) }]);
        expect(() => readTarEntries(OP, tar.subarray(0, 1024))).toThrow(/not a tar/);
        expect(() => readTarEntries(OP, tar.subarray(0, tar.length - 1024))).toThrow(/not a tar/);
    });
});

describe('readChartArchive', () => {
    it("reads the chart's own Chart.yaml, values.yaml and values.schema.json", async () => {
        await expect(readChartArchive(OP, nginxChart())).resolves.toEqual({
            chartYaml: NGINX_CHART_YAML,
            valuesYaml: '# How many pods\nreplicaCount: 1\n',
            valuesSchema: '{"type":"object"}',
        });
    });

    it('answers null for the values files a chart does not ship, and ignores those of its subcharts', async () => {
        const archive = gzipOf([
            { name: 'nginx/Chart.yaml', body: NGINX_CHART_YAML },
            { name: 'nginx/charts/common/values.yaml', body: 'sub: true\n' },
        ]);
        await expect(readChartArchive(OP, archive)).resolves.toEqual({
            chartYaml: NGINX_CHART_YAML,
            valuesYaml: null,
            valuesSchema: null,
        });
    });

    it('refuses an archive with no Chart.yaml, since it is not a chart', async () => {
        const archive = gzipOf([
            { name: 'nginx/values.yaml', body: 'a: 1\n' },
            { name: 'nginx/charts/sub/Chart.yaml', body: 'name: sub\n' },
        ]);
        await expect(readChartArchive(OP, archive)).rejects.toMatchObject({ kind: 'invalid', op: OP });
    });

    it('refuses the whole archive over one entry with an absolute path or a parent reference', async () => {
        for (const entry of [
            { name: '/etc/cron.d/x' },
            { name: 'nginx/../../.bashrc' },
            { name: 'nginx\\..\\..\\x' },
            { name: 'nginx/ok', paxPath: '../escape' },
            { name: 'nginx/ok', gnuLongName: '/abs/escape' },
            { name: 'escape', prefix: '/abs' },
        ]) {
            await expect(readChartArchive(OP, nginxChart([entry])), JSON.stringify(entry)).rejects.toMatchObject({
                kind: 'invalid',
                detail: expect.stringMatching(/unsafe/),
            });
        }
    });

    it('refuses links and every other entry that is not a file or a directory', async () => {
        for (const type of ['1', '2', '3', '4', '6']) {
            const archive = nginxChart([{ name: 'nginx/templates/link.yaml', type }]);
            await expect(readChartArchive(OP, archive), type).rejects.toMatchObject({
                kind: 'invalid',
                detail: expect.stringMatching(/not a plain file/),
            });
        }
    });

    it('refuses a file beside the chart directory, which is outside the chart', async () => {
        await expect(readChartArchive(OP, nginxChart([{ name: 'README.md' }]))).rejects.toMatchObject({
            kind: 'invalid',
            detail: expect.stringMatching(/outside the chart/),
        });
    });

    it('refuses bytes that are not gzip, and gzip that is not a tar', async () => {
        await expect(readChartArchive(OP, Buffer.from('<html>login</html>'))).rejects.toMatchObject({
            kind: 'invalid',
            detail: expect.stringMatching(/not gzip/),
        });
        await expect(readChartArchive(OP, gzipSync(Buffer.alloc(512, 'x')))).rejects.toMatchObject({
            kind: 'invalid',
            detail: expect.stringMatching(/not a tar/),
        });
    });

    it('stops expanding an archive past the ceiling instead of holding all of it', async () => {
        const bomb = gzipSync(Buffer.alloc(MAX_EXPANDED_BYTES + 1));
        await expect(readChartArchive(OP, bomb)).rejects.toMatchObject({
            kind: 'invalid',
            detail: expect.stringMatching(/expands past/),
        });
    });
});
