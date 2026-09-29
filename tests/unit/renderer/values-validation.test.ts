import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '../../../src/shared/chart-values';
import {
    chartDefaults,
    readValues,
    rebaseValues,
    validateValues,
    valueOverrides,
    valuesForRender,
} from '@/lib/values-validation';
import { WEB_DEFAULTS, webChart } from './values-schema-fixture';

const defaults = chartDefaults(WEB_DEFAULTS);

/** What each diagnostic covers in the text, with its severity and message. */
function marks(text: string, schema: JsonSchema | null = webChart, chartValues: unknown = defaults) {
    return validateValues(text, schema, chartValues).map((mark) => ({
        at: text.slice(mark.from, mark.to),
        severity: mark.severity,
        message: mark.message,
    }));
}

describe('reading values', () => {
    it('takes empty text as no values, and a mapping as values', () => {
        expect(readValues('').diagnostics).toEqual([]);
        expect(readValues('# nothing set\n').diagnostics).toEqual([]);
        expect(readValues('replicaCount: 2\n').doc).not.toBeNull();
    });

    it('refuses what Helm cannot read as values: bad YAML, a list or a scalar, a second document', () => {
        expect(readValues('image: [\n').diagnostics[0]).toMatchObject({ severity: 'error' });
        expect(readValues('- a\n- b\n').diagnostics).toEqual([
            expect.objectContaining({ message: 'Values are a YAML mapping of keys to values.' }),
        ]);
        expect(readValues('just text\n').diagnostics).toHaveLength(1);
        expect(readValues('a: 1\n---\nb: 2\n').diagnostics).toEqual([
            expect.objectContaining({ message: 'Values are a single YAML document; Helm reads only the first.' }),
        ]);
    });

    it('checks the YAML even for a chart that ships no schema', () => {
        expect(marks('a: 1\n', null)).toEqual([]);
        expect(marks('- a\n', null)).toHaveLength(1);
    });
});

describe('checking values against the chart’s schema', () => {
    it('accepts the chart’s own defaults', () => {
        expect(marks(WEB_DEFAULTS)).toEqual([]);
    });

    it('marks a wrong type on the value, following a $ref into definitions', () => {
        expect(marks('replicaCount: two\nimage:\n  repository: 5\n')).toEqual([
            { at: 'two', severity: 'error', message: 'Expected a whole number, found a string.' },
            {
                at: '5',
                severity: 'error',
                message: 'Expected a string, found a whole number. Quote the value to keep it a string.',
            },
        ]);
    });

    it('reads a list of types, an enum and a const', () => {
        expect(marks('service:\n  port: http\n')).toEqual([]);
        expect(marks('service:\n  port: 80\n  type: Internal\n')).toEqual([
            {
                at: 'Internal',
                severity: 'error',
                message: 'Must be one of "ClusterIP", "NodePort", "LoadBalancer".',
            },
        ]);
        expect(marks('mode: fast\n')).toEqual([{ at: 'fast', severity: 'error', message: 'Must be "standard".' }]);
        expect(marks('mode: standard\n')).toEqual([]);
    });

    it('refuses a key a closed object does not allow, naming the one probably meant', () => {
        expect(marks('service:\n  prt: 80\n')).toEqual([
            { at: 'prt', severity: 'error', message: '"prt" is not allowed here. Did you mean "port"?' },
        ]);
    });

    it('checks additionalProperties and patternProperties against the keys they cover', () => {
        expect(marks('env:\n  A: x\n  B: 2\n')).toEqual([
            {
                at: '2',
                severity: 'error',
                message: 'Expected a string, found a whole number. Quote the value to keep it a string.',
            },
        ]);
        expect(marks('labels:\n  app.tier: 1\n  other: 1\n')).toEqual([
            expect.objectContaining({ at: '1', severity: 'error' }),
        ]);
    });

    it('holds every half of an allOf, and items through a $ref into $defs', () => {
        // Read as YAML 1.2, where `yes` is a string rather than true.
        expect(marks('ingress:\n  enabled: yes\n')).toEqual([
            { at: 'ingress', severity: 'error', message: 'Missing required value "hosts".' },
            { at: 'yes', severity: 'error', message: 'Expected true or false, found a string.' },
        ]);
        expect(marks('ingress:\n  enabled: true\n  hosts:\n    - host: a.example\n    - paths: [/]\n')).toEqual([
            { at: 'paths', severity: 'error', message: 'Missing required value "host".' },
        ]);
    });

    it('accepts a value matching one branch of a oneOf, and marks it when it matches none', () => {
        expect(marks('resources: small\n')).toEqual([]);
        expect(marks('resources:\n  cpu: 100m\n')).toEqual([]);
        // Only the object branch takes an object, so its own complaint is the one to show.
        expect(marks('resources:\n  cpu: 1\n')).toEqual([
            {
                at: '1',
                severity: 'error',
                message: 'Expected a string, found a whole number. Quote the value to keep it a string.',
            },
        ]);
        expect(marks('resources: medium\n')).toEqual([
            { at: 'medium', severity: 'error', message: 'Must be one of "small", "large".' },
        ]);
        expect(marks('resources: 3\n')).toEqual([
            {
                at: '3',
                severity: 'error',
                message: 'Matches none of the forms allowed here: a string or an object.',
            },
        ]);
    });

    it('checks a tuple position by position, and true and false schemas as everything and nothing', () => {
        expect(marks('pair: [a, 1]\n')).toEqual([]);
        expect(marks('pair: [a, b]\n')).toEqual([expect.objectContaining({ at: 'b', severity: 'error' })]);
        expect(marks('extra:\n  anything: [1, 2]\n')).toEqual([]);
        expect(marks('forbidden: 1\n')).toEqual([
            { at: '1', severity: 'error', message: 'The chart’s schema allows no value here.' },
        ]);
    });

    it('lets a reference outside the file and null through, as nothing it can check', () => {
        expect(marks('remote: 12\n')).toEqual([]);
        expect(marks('replicaCount:\nservice:\n  type: ~\n')).toEqual([]);
    });

    it('counts a required value the chart’s defaults still supply, but not one nulled out', () => {
        // Helm merges the edited values over the chart's own, so a key left out keeps its default.
        expect(marks('replicaCount: 2\n')).toEqual([]);
        expect(marks('image:\n  tag: v1\n')).toEqual([]);
        // A null deletes the default it stands over, which Helm then reports as missing.
        expect(marks('image:\n  repository: null\n')).toEqual([
            { at: 'image', severity: 'error', message: 'Missing required value "repository".' },
        ]);
        expect(marks('replicaCount: 2\n', webChart, {})).toEqual([
            { at: 'replicaCount', severity: 'error', message: 'Missing required value "image".' },
        ]);
        expect(marks('', webChart, {})).toEqual([
            { at: '', severity: 'error', message: 'Missing required value "image".' },
        ]);
    });

    it('warns about a key neither the schema nor the chart’s values name, since Helm passes it on unread', () => {
        expect(marks('replicaCont: 2\n')).toEqual([
            {
                at: 'replicaCont',
                severity: 'warning',
                message: '"replicaCont" is not a value this chart names. Did you mean "replicaCount"?',
            },
        ]);
        // A key the chart's own values carry is the chart's, whatever the schema lists.
        expect(
            marks('image:\n  repository: a\n  digest: sha\n', webChart, chartDefaults('image:\n  digest: ""\n')),
        ).toEqual([]);
        // `global` is Helm's, and a subchart's section is checked against the subchart's own schema.
        expect(marks('global:\n  domain: x\npostgresql:\n  auth: {}\n', webChart, defaults)).toEqual([
            expect.objectContaining({ at: 'postgresql', severity: 'warning' }),
        ]);
        expect(
            validateValues('global:\n  domain: x\npostgresql:\n  auth: {}\n', webChart, defaults, ['postgresql']),
        ).toEqual([]);
        // An object the schema leaves open says nothing about the keys it has not listed.
        expect(marks('extra:\n  anything: 1\nenv:\n  ANY: x\n')).toEqual([]);
    });

    it('survives a schema whose keywords are the wrong shape, and one that refers to itself', () => {
        const odd = { type: 7, properties: [], required: 'image', enum: 'x', allOf: {}, items: 'no' } as JsonSchema;
        expect(marks('a: 1\n', odd)).toEqual([]);
        const loop: JsonSchema = { $ref: '#/definitions/a', definitions: { a: { $ref: '#/definitions/a' } } };
        expect(marks('a: 1\n', loop)).toEqual([]);
        const tree: JsonSchema = {
            $ref: '#/definitions/node',
            definitions: {
                node: {
                    type: 'object',
                    properties: { value: { type: 'integer' }, child: { $ref: '#/definitions/node' } },
                },
            },
        };
        expect(marks('child:\n  child:\n    value: x\n', tree)).toEqual([
            expect.objectContaining({ at: 'x', severity: 'error' }),
        ]);
    });
});

describe('chartDefaults', () => {
    it('reads the chart’s values.yaml, and anything unreadable as no defaults', () => {
        expect(chartDefaults('a: 1\nb:\n  c: true\n')).toEqual({ a: 1, b: { c: true } });
        expect(chartDefaults('')).toEqual({});
        expect(chartDefaults('- a\n')).toEqual({});
        expect(chartDefaults('a: [\n')).toEqual({});
    });
});

describe('the values handed to Helm', () => {
    it('reads the text as YAML 1.2, as the editor checks it, so yes stays a string and 010 is ten', () => {
        expect(valuesForRender('enabled: yes\nport: 010\nmode: on\nreal: true\nname: ~\n')).toEqual({
            values: { enabled: 'yes', port: 10, mode: 'on', real: true, name: null },
        });
    });

    it('hands over values that survive JSON unchanged, anchors expanded', () => {
        const values = valuesForRender('base: &b\n  tag: "1.0"\n  list: [1, 2]\ncopy: *b\n');
        expect(values).toEqual({ values: { base: { tag: '1.0', list: [1, 2] }, copy: { tag: '1.0', list: [1, 2] } } });
        if ('values' in values) expect(JSON.parse(JSON.stringify(values.values))).toEqual(values.values);
    });

    it('takes empty text, or comments alone, as no values', () => {
        expect(valuesForRender('')).toEqual({ values: {} });
        expect(valuesForRender('# defaults only\n')).toEqual({ values: {} });
    });

    it('hands nothing over for text that does not read, or a number JSON cannot carry', () => {
        expect(valuesForRender('image: [\n')).toEqual({ problem: expect.stringMatching(/^The values are not YAML/) });
        expect(valuesForRender('- a\n')).toEqual({ problem: expect.stringMatching(/mapping/) });
        expect(valuesForRender('ratio: .inf\n')).toEqual({ problem: expect.stringMatching(/\.inf/) });
        expect(valuesForRender('nested:\n  - .nan\n')).toEqual({ problem: expect.stringMatching(/\.nan/) });
    });
});

describe('the overrides handed to Helm', () => {
    const overrides = (text: string, defaults: string) => {
        const parsed = valuesForRender(text);
        if ('problem' in parsed) throw new Error(parsed.problem);
        return valueOverrides(parsed.values, defaults);
    };

    it('leaves out a default the text still holds, so Helm reads yes from values.yaml as YAML 1.1 does', () => {
        expect(overrides('enabled: yes\ngreeting: hello\n', 'enabled: yes\ngreeting: hello\n')).toEqual({});
    });

    it('keeps a yes the user typed over another default as the string the editor showed', () => {
        expect(overrides('enabled: yes\n', 'enabled: false\n')).toEqual({ enabled: 'yes' });
        expect(overrides('enabled: yes\nextra: on\n', '')).toEqual({ enabled: 'yes', extra: 'on' });
    });

    it('hands a value nulled out to Helm as null, which is how Helm deletes a default', () => {
        expect(overrides('greeting: null\nimage:\n  tag: ~\n', 'greeting: hello\nimage:\n  tag: "1.0"\n')).toEqual({
            greeting: null,
            image: { tag: null },
        });
    });

    it('leaves a key taken out of the text to its default, as the editor checks it', () => {
        expect(overrides('greeting: hello\n', 'greeting: hello\nreplicas: 1\n')).toEqual({});
    });

    it('walks into mappings and hands over only what changed in them', () => {
        const defaults = 'image:\n  repository: nginx\n  tag: "1.0"\n  pull: IfNotPresent\nports: [80, 443]\n';
        expect(overrides('image:\n  repository: nginx\n  tag: "1.1"\nports: [80, 443]\n', defaults)).toEqual({
            image: { tag: '1.1' },
        });
    });

    it('hands over a list whole when it changed at all, since Helm replaces a list rather than merging it', () => {
        expect(overrides('ports: [80]\n', 'ports: [80, 443]\n')).toEqual({ ports: [80] });
        expect(overrides('hosts:\n  - name: a\n', 'hosts:\n  - name: a\n    tls: true\n')).toEqual({
            hosts: [{ name: 'a' }],
        });
    });

    it('hands over a value whose shape differs from its default', () => {
        expect(overrides('image: nginx\n', 'image:\n  repository: nginx\n')).toEqual({ image: 'nginx' });
        expect(overrides('image:\n  repository: nginx\n', 'image: nginx\n')).toEqual({
            image: { repository: 'nginx' },
        });
    });

    it('compares mappings whatever order their keys were written in', () => {
        expect(overrides('image: { tag: "1", name: a }\n', 'image:\n  name: a\n  tag: "1"\n')).toEqual({});
    });

    it('hands over every value when the defaults do not read, since there is nothing to leave to them', () => {
        expect(overrides('enabled: yes\n', 'enabled: [\n')).toEqual({ enabled: 'yes' });
        expect(overrides('enabled: yes\n', '- a\n')).toEqual({ enabled: 'yes' });
    });
});

describe('carrying an edit to another chart version', () => {
    const old = 'replicaCount: 1\nimage:\n  repository: nginx\n  tag: "1.0"\n';
    const next = '# how many\nreplicaCount: 1\nimage:\n  repository: nginx\n  tag: "2.0" # the app\n';

    it('takes the new defaults for everything the edit left alone', () => {
        const rebased = rebaseValues(old.replace('replicaCount: 1', 'replicaCount: 3'), old, next);
        expect(rebased).toBe('# how many\nreplicaCount: 3\nimage:\n  repository: nginx\n  tag: "2.0" # the app\n');
        const parsed = valuesForRender(rebased!);
        if ('problem' in parsed) throw new Error(parsed.problem);
        expect(valueOverrides(parsed.values, next)).toEqual({ replicaCount: 3 });
    });

    it('keeps a value the user changed even where the new defaults changed it too', () => {
        const rebased = rebaseValues(old.replace('"1.0"', '"1.5"'), old, next);
        expect(valuesForRender(rebased!)).toEqual({
            values: { replicaCount: 1, image: { repository: 'nginx', tag: '1.5' } },
        });
    });

    it('carries added keys, nulls, lists and values of another shape whole', () => {
        const text = 'replicaCount: 1\nimage: busybox\nextra:\n  a: [1, 2]\ngreeting: null\n';
        const from = 'replicaCount: 1\nimage:\n  tag: "1.0"\ngreeting: hello\n';
        const to = 'replicaCount: 2\nimage:\n  tag: "2.0"\ngreeting: hi\n';
        expect(valuesForRender(rebaseValues(text, from, to)!)).toEqual({
            values: { replicaCount: 2, image: 'busybox', extra: { a: [1, 2] }, greeting: null },
        });
    });

    it('writes into a mapping the new version holds and over a value of another shape', () => {
        const text = 'image:\n  tag: "1.5"\n';
        expect(valuesForRender(rebaseValues(text, 'image:\n  tag: "1.0"\n', 'image: nginx\n')!)).toEqual({
            values: { image: { tag: '1.5' } },
        });
        expect(rebaseValues(text, 'image:\n  tag: "1.0"\n', '# none yet\n')).toBe(text);
    });

    it('has nothing to carry when the text or either file does not read', () => {
        expect(rebaseValues('image: [\n', old, next)).toBeNull();
        expect(rebaseValues(old, 'image: [\n', next)).toBeNull();
        expect(rebaseValues(old, old, '- a\n')).toBeNull();
    });
});
