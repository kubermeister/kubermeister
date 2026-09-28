import { describe, expect, it } from 'vitest';
import { gzipOf } from './chart-archive-fixture';

const { chartMetadata, helmChartRecord } = await import('../../../src/main/charts/release-chart.js');

const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('chartMetadata', () => {
    it('keeps every scalar as the string Chart.yaml wrote, so 1.10 is not read as 1.1', () => {
        expect(
            chartMetadata(
                'apiVersion: v2\nname: demo\nversion: 1.10.0\nappVersion: 1.10\ndeprecated: true\nkeywords: [web, 3]\nannotations:\n  a: b\n',
            ),
        ).toEqual({
            apiVersion: 'v2',
            name: 'demo',
            version: '1.10.0',
            appVersion: '1.10',
            deprecated: true,
            keywords: ['web', '3'],
            annotations: { a: 'b' },
        });
    });

    it('reads maintainers and dependencies in Helm’s shape and leaves out keys Helm does not know', () => {
        const metadata = chartMetadata(
            [
                'name: demo',
                'version: 0.1.0',
                'custom: [1, 2]',
                'maintainers:',
                '  - name: Ops',
                '    email: ops@example.com',
                'dependencies:',
                '  - name: redis',
                '    version: 18.x',
                '    alias: cache',
                '    enabled: false',
                '    tags: [cache]',
                '  - version: 1.0.0',
            ].join('\n'),
        );
        expect(metadata).toEqual({
            name: 'demo',
            version: '0.1.0',
            maintainers: [{ name: 'Ops', email: 'ops@example.com' }],
            dependencies: [{ name: 'redis', version: '18.x', alias: 'cache', enabled: false, tags: ['cache'] }],
        });
    });

    it('reads a Chart.yaml that is not a mapping as no metadata', () => {
        expect(chartMetadata('- a\n')).toEqual({});
        expect(chartMetadata('name: [\n')).toEqual({});
    });
});

describe('helmChartRecord', () => {
    it('stores the top chart’s own files the way Helm serialises its Chart, subcharts left out', async () => {
        const record = await helmChartRecord(
            gzipOf([
                { name: 'demo/', type: '5' },
                { name: 'demo/Chart.yaml', body: 'apiVersion: v2\nname: demo\nversion: 0.1.0\n' },
                { name: 'demo/values.yaml', body: 'replicas: 2\nimage:\n  tag: "1.0"\n' },
                { name: 'demo/values.schema.json', body: '{"type":"object"}' },
                { name: 'demo/templates/deployment.yaml', body: 'kind: Deployment\n' },
                { name: 'demo/templates/_helpers.tpl', body: '{{- define "x" }}{{ end }}' },
                { name: 'demo/crds/widgets.yaml', body: 'kind: CustomResourceDefinition\n' },
                { name: 'demo/README.md', body: '# Demo\n' },
                { name: 'demo/charts/redis/Chart.yaml', body: 'name: redis\n' },
            ]),
        );
        expect(record).toEqual({
            metadata: { apiVersion: 'v2', name: 'demo', version: '0.1.0' },
            lock: null,
            templates: [
                { name: 'templates/deployment.yaml', data: b64('kind: Deployment\n') },
                { name: 'templates/_helpers.tpl', data: b64('{{- define "x" }}{{ end }}') },
            ],
            values: { replicas: 2, image: { tag: '1.0' } },
            schema: b64('{"type":"object"}'),
            files: [
                { name: 'crds/widgets.yaml', data: b64('kind: CustomResourceDefinition\n') },
                { name: 'README.md', data: b64('# Demo\n') },
            ],
        });
    });

    it('records no schema and empty defaults for a chart that ships neither', async () => {
        const record = await helmChartRecord(
            gzipOf([{ name: 'demo/Chart.yaml', body: 'name: demo\nversion: 1.0.0\n' }]),
        );
        expect(record).toMatchObject({ schema: null, values: {}, templates: [], files: [] });
    });
});
