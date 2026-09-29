import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { FAILSAFE_SCHEMA, load as loadYaml } from 'js-yaml';
import { MAX_EXPANDED_BYTES, readTarEntries } from './archive.js';

/**
 * The chart as a Helm release Secret stores it, which is Go's JSON of Helm's own `Chart`: the
 * `Chart.yaml` metadata, the templates, the default values, the schema and the chart's other files,
 * every file's bytes base64 as Go writes a `[]byte`. Subcharts are not in it, since Helm's struct
 * does not serialise them. The Helm CLI reads this back for `helm get`, `helm rollback` and
 * `helm upgrade --reuse-values`, so a release this app installs carries it as Helm's would.
 */

const gunzipAsync = promisify(gunzip);

export interface HelmChartFile {
    name: string;
    /** Base64. */
    data: string;
}

export interface HelmChartRecord {
    metadata: Record<string, unknown>;
    lock: null;
    templates: HelmChartFile[];
    values: Record<string, unknown>;
    /** Base64 of `values.schema.json`, or null for a chart without one. */
    schema: string | null;
    files: HelmChartFile[];
}

/** The files Helm's loader reads into a field of their own rather than keeping among `files`. */
const OWN_FIELDS = new Set([
    'Chart.yaml',
    'Chart.lock',
    'values.yaml',
    'values.schema.json',
    'requirements.yaml',
    'requirements.lock',
]);

const STRING_LISTS = new Set(['keywords', 'sources']);
const STRING_MAPS = new Set(['annotations']);
const METADATA_STRINGS = new Set([
    'name',
    'home',
    'version',
    'description',
    'icon',
    'apiVersion',
    'condition',
    'tags',
    'appVersion',
    'kubeVersion',
    'type',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [];

function stringMap(value: unknown): Record<string, string> {
    if (!isRecord(value)) return {};
    return Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
}

function dependency(value: unknown): Record<string, unknown> | null {
    if (!isRecord(value) || typeof value.name !== 'string') return null;
    const out: Record<string, unknown> = { name: value.name };
    for (const key of ['version', 'repository', 'condition', 'alias'] as const) {
        if (typeof value[key] === 'string') out[key] = value[key];
    }
    if (Array.isArray(value.tags)) out.tags = strings(value.tags);
    if (value.enabled !== undefined) out.enabled = value.enabled === 'true';
    if (Array.isArray(value['import-values'])) out['import-values'] = value['import-values'];
    return out;
}

/**
 * `Chart.yaml` in the shape Go unmarshals into Helm's `Metadata`. It is read with every scalar a
 * string, as Helm's YAML reader reads into string fields, so `version: 1.10` stays `1.10` rather
 * than becoming the number 1.1; the two booleans are turned back into booleans. A key Helm does not
 * know is left out, since a stray type there would stop the Helm CLI reading the whole release.
 */
export function chartMetadata(chartYaml: string): Record<string, unknown> {
    let raw: unknown;
    try {
        raw = loadYaml(chartYaml, { schema: FAILSAFE_SCHEMA });
    } catch {
        return {};
    }
    if (!isRecord(raw)) return {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (METADATA_STRINGS.has(key) && typeof value === 'string') out[key] = value;
        else if (STRING_LISTS.has(key)) out[key] = strings(value);
        else if (STRING_MAPS.has(key)) out[key] = stringMap(value);
        else if (key === 'deprecated') out[key] = value === 'true';
        else if (key === 'maintainers' && Array.isArray(value)) {
            out[key] = value.filter(isRecord).map((maintainer) => stringMap(maintainer));
        } else if (key === 'dependencies' && Array.isArray(value)) {
            out[key] = value.map(dependency).filter((one) => one !== null);
        }
    }
    return out;
}

/** The chart's defaults as Helm stores them; a `values.yaml` that does not read is none. */
function defaultValues(text: string | undefined): Record<string, unknown> {
    if (text === undefined) return {};
    try {
        const parsed = loadYaml(text);
        return isRecord(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * Read an archive `fetchChart` has already checked into the record a release stores. Only the top
 * chart's own files are kept: `charts/` holds the subcharts, which Helm leaves out of the record.
 */
export async function helmChartRecord(archive: Buffer): Promise<HelmChartRecord> {
    const tar = await gunzipAsync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
    const templates: HelmChartFile[] = [];
    const files: HelmChartFile[] = [];
    const own = new Map<string, Buffer>();
    for (const entry of readTarEntries('charts.install', tar)) {
        if (entry.type !== '0' && entry.type !== '7') continue;
        const inChart = entry.name
            .replaceAll('\\', '/')
            .split('/')
            .filter((part) => part !== '' && part !== '.')
            .slice(1);
        const name = inChart.join('/');
        if (!name || inChart[0] === 'charts') continue;
        const file = { name, data: entry.data.toString('base64') };
        if (inChart[0] === 'templates') templates.push(file);
        else if (OWN_FIELDS.has(name)) own.set(name, entry.data);
        else files.push(file);
    }
    const schema = own.get('values.schema.json');
    return {
        metadata: chartMetadata(own.get('Chart.yaml')?.toString('utf8') ?? ''),
        lock: null,
        templates,
        values: defaultValues(own.get('values.yaml')?.toString('utf8')),
        schema: schema ? schema.toString('base64') : null,
        files,
    };
}
