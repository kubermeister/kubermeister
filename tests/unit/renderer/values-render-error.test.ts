import { describe, expect, it } from 'vitest';
import { placeRenderError, readRenderError } from '@/lib/values-render-error';

/** As `helmErrorMessage` hands them on: `Error:` and the --debug advice dropped, one line per line. */
const HELM4_SCHEMA = [
    "values don't meet the specifications of the schema(s) in the following chart(s):",
    'demo:',
    "- at '/service': additional properties 'colour' not allowed",
    "- at '/replicaCount': got string, want integer",
    "- at '/image': validation failed",
    "- at '/image': missing property 'repository'",
    "- at '/image/pullPolicy': value must be one of 'Always', 'IfNotPresent', 'Never'",
].join('\n');

const HELM3_SCHEMA = [
    "values don't meet the specifications of the schema(s) in the following chart(s):",
    'demo:',
    '- (root): image is required',
    '- replicaCount: Invalid type. Expected: integer, given: string',
    'db:',
    '- auth.password: Invalid type. Expected: string, given: integer',
].join('\n');

const VALUES =
    'replicaCount: two\nimage:\n  pullPolicy: Sometimes\n  repository: null\nservice:\n  colour: red\ndb:\n  auth:\n    password: 1\n';

const marks = (text: string, message: string) =>
    placeRenderError(text, message).diagnostics.map((mark) => ({
        at: text.slice(mark.from, mark.to),
        message: mark.message,
    }));

describe('reading a render error', () => {
    it('reads each value Helm 4’s schema check refuses, skipping the wrapper line', () => {
        const read = readRenderError(HELM4_SCHEMA);
        expect(read.summary).toBe('The values do not match the chart’s schema.');
        expect(read.problems).toEqual([
            { path: ['service'], message: "additional properties 'colour' not allowed", where: null },
            { path: ['replicaCount'], message: 'got string, want integer', where: null },
            { path: ['image'], message: "missing property 'repository'", where: null },
            {
                path: ['image', 'pullPolicy'],
                message: "value must be one of 'Always', 'IfNotPresent', 'Never'",
                where: null,
            },
        ]);
    });

    it('reads Helm 3’s wording too, and puts a subchart’s paths under its section', () => {
        expect(readRenderError(HELM3_SCHEMA).problems).toEqual([
            { path: [], message: 'image is required', where: null },
            { path: ['replicaCount'], message: 'Invalid type. Expected: integer, given: string', where: null },
            {
                path: ['db', 'auth', 'password'],
                message: 'Invalid type. Expected: string, given: integer',
                where: null,
            },
        ]);
    });

    it('unescapes a JSON Pointer', () => {
        const read = readRenderError(
            "values don't meet the specifications of the schema(s) in the following chart(s):\ndemo:\n- at '/labels/app.kubernetes.io~1name': got number, want string",
        );
        expect(read.problems[0]?.path).toEqual(['labels', 'app.kubernetes.io/name']);
    });

    it('reads a failed `required` or `fail` as the chart’s own sentence, naming its template and line', () => {
        const read = readRenderError('execution error at (demo/templates/ingress.yaml:12:5): a host is required');
        expect(read.summary).toBe('The chart did not render with these values.');
        expect(read.problems).toEqual([
            { path: null, message: 'a host is required', where: 'demo/templates/ingress.yaml, line 12' },
        ]);
    });

    it('names the value a template failed on, saying which part of the way to it is unset', () => {
        const read = readRenderError(
            'demo/templates/x.yaml:1:13\nexecuting "demo/templates/x.yaml" at <.Values.image.digest.sha>:\nnil pointer evaluating interface {}.sha',
        );
        expect(read.problems).toEqual([
            {
                path: ['image', 'digest', 'sha'],
                message: 'The chart reads .Values.image.digest.sha, but "digest" is not set.',
                where: 'demo/templates/x.yaml, line 1',
            },
        ]);
        const typed = readRenderError(
            'template: demo/templates/x.yaml:4:20: executing "demo/templates/x.yaml" at <.Values.port>: wrong type for value; expected string; got int',
        );
        expect(typed.problems).toEqual([
            {
                path: ['port'],
                message: 'wrong type for value; expected string; got int',
                where: 'demo/templates/x.yaml, line 4',
            },
        ]);
    });

    it('keeps anything else whole, as Helm said it', () => {
        expect(
            readRenderError('chart requires kubeVersion: >=1.30 which is incompatible with v1.28.0').problems,
        ).toEqual([
            {
                path: null,
                message: 'chart requires kubeVersion: >=1.30 which is incompatible with v1.28.0',
                where: null,
            },
        ]);
    });
});

describe('placing a render error on the values', () => {
    it('marks each refused value on its key, and a missing one on the object that lacks it', () => {
        expect(marks(VALUES, HELM4_SCHEMA)).toEqual([
            { at: 'replicaCount', message: 'got string, want integer' },
            { at: 'image', message: "missing property 'repository'" },
            { at: 'pullPolicy', message: "value must be one of 'Always', 'IfNotPresent', 'Never'" },
            { at: 'service', message: "additional properties 'colour' not allowed" },
        ]);
        expect(placeRenderError(VALUES, HELM4_SCHEMA).notes).toEqual([]);
    });

    it('marks a subchart’s value in its section, and leaves what concerns the whole as a note', () => {
        const placed = placeRenderError(VALUES, HELM3_SCHEMA);
        expect(placed.diagnostics.map((mark) => VALUES.slice(mark.from, mark.to))).toEqual([
            'replicaCount',
            'password',
        ]);
        expect(placed.notes).toEqual([{ message: 'image is required', where: null }]);
    });

    it('marks the nearest value the text holds on the way to one it lacks, and notes one it holds nothing of', () => {
        const message =
            'demo/templates/x.yaml:1:13\nexecuting "demo/templates/x.yaml" at <.Values.image.digest.sha>:\nnil pointer evaluating interface {}.sha';
        expect(marks('image:\n  tag: v1\n', message)).toEqual([
            {
                at: 'image',
                message:
                    'The chart reads .Values.image.digest.sha, but "digest" is not set. (demo/templates/x.yaml, line 1)',
            },
        ]);
        expect(placeRenderError('replicaCount: 1\n', message).notes).toEqual([
            {
                message: 'The chart reads .Values.image.digest.sha, but "digest" is not set.',
                where: 'demo/templates/x.yaml, line 1',
            },
        ]);
    });

    it('follows a list index, and notes everything when the text does not parse', () => {
        const message =
            "values don't meet the specifications of the schema(s) in the following chart(s):\ndemo:\n- at '/hosts/1/host': got number, want string";
        expect(marks('hosts:\n  - host: a\n  - host: 2\n', message)).toEqual([
            { at: 'host', message: 'got number, want string' },
        ]);
        expect(placeRenderError('hosts:\n  - host: a\n  - host: 2\n', message).diagnostics[0]?.from).toBe(
            'hosts:\n  - host: a\n  - '.length,
        );
        expect(placeRenderError('hosts: [\n', message)).toMatchObject({
            diagnostics: [],
            notes: [{ message: 'got number, want string', where: null }],
        });
    });
});
