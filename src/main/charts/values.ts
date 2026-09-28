import { load as loadYaml } from 'js-yaml';
import type { ChartValues, JsonSchema } from '../../shared/chart-values.js';
import { fetchChart } from './fetch.js';

/**
 * A chart's `values.schema.json` read for the editor. One that is not JSON, or JSON that is no
 * schema, still leaves the values editable as plain YAML: Helm refuses such a chart when it renders,
 * and says so in its own words, so the editor only has to say why it checks nothing.
 */
export function parseValuesSchema(text: string | null): Pick<ChartValues, 'schema' | 'schemaProblem'> {
    if (text === null) return { schema: null, schemaProblem: null };
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { schema: null, schemaProblem: 'The chart’s values.schema.json is not JSON.' };
    }
    const isSchema =
        typeof parsed === 'boolean' || (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
    return isSchema
        ? { schema: parsed as JsonSchema, schemaProblem: null }
        : { schema: null, schemaProblem: 'The chart’s values.schema.json is not a JSON Schema.' };
}

/**
 * The keys a chart's dependencies take their values under: each one's `alias`, or its `name`. The
 * archive's `Chart.yaml` has already been read as YAML naming this chart, so anything else about it
 * that is not the expected shape is simply no dependency.
 */
export function subchartKeys(chartYaml: string): string[] {
    let metadata: unknown;
    try {
        metadata = loadYaml(chartYaml);
    } catch {
        return [];
    }
    const dependencies = (metadata as { dependencies?: unknown } | null)?.dependencies;
    if (!Array.isArray(dependencies)) return [];
    const keys = dependencies.map((dependency: { alias?: unknown; name?: unknown } | null) => {
        const key = dependency?.alias ?? dependency?.name;
        return typeof key === 'string' && key !== '' ? key : null;
    });
    return [...new Set(keys.filter((key): key is string => key !== null))];
}

/**
 * The values a chart version starts from and the schema they are checked against, read from the
 * archive `fetchChart` checked and cached, so what is edited is the very chart that renders.
 */
export async function readChartValues(source: string, chart: string, version: string): Promise<ChartValues> {
    const fetched = await fetchChart(source, chart, version);
    return {
        valuesYaml: fetched.valuesYaml ?? '',
        ...parseValuesSchema(fetched.valuesSchema),
        subcharts: subchartKeys(fetched.chartYaml),
    };
}
