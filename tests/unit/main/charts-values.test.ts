import { beforeEach, describe, expect, it, vi } from 'vitest';
import { K8sError } from '../../../src/main/k8s/errors';

const fetchMod = { fetchChart: vi.fn() };
vi.mock('../../../src/main/charts/fetch.js', () => fetchMod);

const { parseValuesSchema, readChartValues, subchartKeys } = await import('../../../src/main/charts/values.js');

const fetched = (
    valuesYaml: string | null,
    valuesSchema: string | null,
    chartYaml = 'name: nginx\nversion: 1.0.0\n',
) => ({
    path: '/cache/example/abc.tgz',
    digest: 'abc',
    chartYaml,
    valuesYaml,
    valuesSchema,
});

describe('parseValuesSchema', () => {
    it('reads a schema object, and true and false, which are schemas too', () => {
        expect(parseValuesSchema('{"type":"object"}')).toEqual({ schema: { type: 'object' }, schemaProblem: null });
        expect(parseValuesSchema('true')).toEqual({ schema: true, schemaProblem: null });
        expect(parseValuesSchema(null)).toEqual({ schema: null, schemaProblem: null });
    });

    it('says why a schema the chart ships is not used, rather than failing the values with it', () => {
        expect(parseValuesSchema('{ not json')).toEqual({
            schema: null,
            schemaProblem: 'The chart’s values.schema.json is not JSON.',
        });
        for (const text of ['[]', '"object"', '12', 'null']) {
            expect(parseValuesSchema(text)).toEqual({
                schema: null,
                schemaProblem: 'The chart’s values.schema.json is not a JSON Schema.',
            });
        }
    });
});

describe('subchartKeys', () => {
    it('names each dependency by its alias, or by its name when it has none', () => {
        const chartYaml =
            'name: web\nversion: 1.0.0\ndependencies:\n  - name: postgresql\n  - name: redis\n    alias: cache\n  - name: redis\n    alias: cache\n';
        expect(subchartKeys(chartYaml)).toEqual(['postgresql', 'cache']);
    });

    it('reads a Chart.yaml with no dependencies, or odd ones, as none', () => {
        expect(subchartKeys('name: web\n')).toEqual([]);
        expect(subchartKeys('dependencies: postgresql\n')).toEqual([]);
        expect(subchartKeys('dependencies:\n  - null\n  - name: 3\n  - alias: ""\n')).toEqual([]);
        expect(subchartKeys('name: [\n')).toEqual([]);
    });
});

describe('readChartValues', () => {
    beforeEach(() => {
        fetchMod.fetchChart.mockReset();
    });

    it('answers the values as written, comments kept, beside the parsed schema of the fetched archive', async () => {
        fetchMod.fetchChart.mockResolvedValue(fetched('# How many\nreplicaCount: 1\n', '{"type":"object"}'));
        await expect(readChartValues('example', 'nginx', '1.0.0')).resolves.toEqual({
            valuesYaml: '# How many\nreplicaCount: 1\n',
            schema: { type: 'object' },
            schemaProblem: null,
            subcharts: [],
        });
        expect(fetchMod.fetchChart).toHaveBeenCalledWith('example', 'nginx', '1.0.0');
    });

    it('starts a chart with no values.yaml from nothing', async () => {
        fetchMod.fetchChart.mockResolvedValue(fetched(null, null));
        await expect(readChartValues('example', 'nginx', '1.0.0')).resolves.toEqual({
            valuesYaml: '',
            schema: null,
            schemaProblem: null,
            subcharts: [],
        });
    });

    it('passes on why the chart could not be fetched', async () => {
        fetchMod.fetchChart.mockRejectedValue(
            new K8sError('notFound', 'nginx 9.9.9 is not in example.', 'charts.fetch'),
        );
        await expect(readChartValues('example', 'nginx', '9.9.9')).rejects.toMatchObject({ kind: 'notFound' });
    });
});
