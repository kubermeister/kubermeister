import { describe, expect, it } from 'vitest';
import { readManifest, validateManifest, type ManifestDiagnostic } from '@/lib/manifest-validation';
import { deployment } from './schema-fixture';

const VALID = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  strategy:
    type: RollingUpdate
  extra:
    anything: [1, 2]
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx
          env:
            - name: MODE
              value: "8080"
          ports:
            - containerPort: 80
          resources:
            limits:
              cpu: 1
              memory: 128Mi
          readinessProbe:
            port: 8080
            grace: 30%
            mode: true
`;

/** Each diagnostic as the text it covers and what it says, which is how a reader sees it. */
function marks(text: string, diagnostics: ManifestDiagnostic[]) {
    return diagnostics.map((diagnostic) => ({
        at: text.slice(diagnostic.from, diagnostic.to),
        severity: diagnostic.severity,
        message: diagnostic.message,
    }));
}

const check = (text: string) => marks(text, validateManifest(text, deployment));

describe('validateManifest', () => {
    it('finds nothing wrong with a manifest that fits its schema', () => {
        expect(check(VALID)).toEqual([]);
    });

    it('marks a value of the wrong type where it is, and says to quote a number meant as a string', () => {
        const text = VALID.replace('replicas: 2', 'replicas: two').replace('value: "8080"', 'value: 8080');
        expect(check(text)).toEqual([
            { at: 'two', severity: 'error', message: 'Expected a whole number, found a string.' },
            {
                at: '8080',
                severity: 'error',
                message: 'Expected a string, found a whole number. Quote the value to keep it a string.',
            },
        ]);
    });

    it('marks a value outside its enum with the values it may take', () => {
        const text = VALID.replace('type: RollingUpdate', 'type: Rolling');
        expect(check(text)).toEqual([
            { at: 'Rolling', severity: 'error', message: 'Must be one of "Recreate", "RollingUpdate".' },
        ]);
    });

    it('warns of a field the schema does not have, naming the one it was probably meant to be', () => {
        const text = VALID.replace('replicas: 2', 'replica: 2').replace(
            'image: nginx',
            'image: nginx\n          colour: red',
        );
        expect(check(text)).toEqual([
            {
                at: 'replica',
                severity: 'warning',
                message: '"replica" is not a field here, so the API server ignores it. Did you mean "replicas"?',
            },
            {
                at: 'colour',
                severity: 'warning',
                message: '"colour" is not a field here, so the API server ignores it.',
            },
        ]);
    });

    it('marks a missing required field on the key that should hold it', () => {
        const text = VALID.replace('        - name: web\n          image: nginx', '        - image: nginx').replace(
            '            - containerPort: 80',
            '            - name: http',
        );
        expect(check(text)).toEqual([
            { at: 'image', severity: 'error', message: 'Missing required field "name".' },
            { at: 'name', severity: 'error', message: 'Missing required field "containerPort".' },
        ]);
        const spec = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 1\n`;
        expect(check(spec)).toEqual([
            { at: 'spec', severity: 'error', message: 'Missing required fields "selector", "template".' },
        ]);
    });

    it('leaves alone what the schema lets be anything, and fields left null', () => {
        const text = VALID.replace('  replicas: 2', '  replicas: null');
        expect(check(text)).toEqual([]);
    });

    it('checks every value of a map against the schema its values share', () => {
        expect(check(VALID.replace('    app: web\nspec', '    app: 3\nspec'))).toEqual([
            {
                at: '3',
                severity: 'error',
                message: 'Expected a string, found a whole number. Quote the value to keep it a string.',
            },
        ]);
    });

    it('accepts either branch of a oneOf, and nothing outside them', () => {
        expect(check(VALID.replace('mode: true', 'mode: [1]'))).toEqual([
            { at: '[1]', severity: 'error', message: 'Expected a string or true or false, found a list.' },
        ]);
    });

    it('checks nothing against a schema for another kind than the manifest names', () => {
        const text = VALID.replace('replicas: 2', 'replicas: two');
        expect(validateManifest(text, { ...deployment, kind: 'StatefulSet' })).toEqual([]);
        expect(validateManifest(text, null)).toEqual([]);
    });
});

describe('readManifest', () => {
    it('is nothing to report for empty text, which is no manifest yet', () => {
        expect(readManifest('  \n')).toEqual({ doc: null, head: null, diagnostics: [] });
    });

    it('names the kind to look the schema up by', () => {
        expect(readManifest(VALID).head).toEqual({ apiVersion: 'apps/v1', kind: 'Deployment' });
        // A kind the schema lookup would refuse is not asked about.
        expect(readManifest(VALID.replace('kind: Deployment', 'kind: not a kind')).head).toBe(null);
    });

    it('marks a YAML syntax error where the parser stopped', () => {
        const text = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\ndata:\n  a: [1, 2\n';
        const { diagnostics, head, doc } = readManifest(text);
        // The kind is still named, so completion can offer fields while the text does not parse.
        expect(head).toEqual({ apiVersion: 'v1', kind: 'ConfigMap' });
        expect(doc).toBe(null);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({ severity: 'error' });
        expect(diagnostics[0]?.message).not.toContain('\n');
    });

    it('refuses what main refuses: a second document, a non-object, and no kind or name', () => {
        const two = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\napiVersion: v1\nkind: ConfigMap\n';
        expect(marks(two, readManifest(two).diagnostics)).toEqual([
            {
                at: 'apiVersion: v1\nkind: ConfigMap\n',
                severity: 'error',
                message: 'A manifest here is a single object; apply the next document on its own.',
            },
        ]);
        expect(readManifest('- a\n- b\n').diagnostics[0]?.message).toBe('The manifest must be a YAML object.');
        const bare = 'metadata:\n  labels: {}\n';
        expect(marks(bare, readManifest(bare).diagnostics)).toEqual([
            { at: 'metadata', severity: 'error', message: 'The manifest must declare apiVersion and kind.' },
            { at: 'metadata', severity: 'error', message: 'The manifest must declare metadata.name.' },
        ]);
        expect(readManifest('apiVersion: v1\nkind: Pod\nmetadata:\n  generateName: web-\n').diagnostics).toEqual([]);
    });
});
