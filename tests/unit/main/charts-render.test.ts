import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    helmErrorMessage,
    isCrdSource,
    renderChart,
    splitRendered,
    templateArgs,
    usesLookup,
    type ChartCapabilities,
} from '../../../src/main/charts/render';
import { gzipOf } from './chart-archive-fixture';

class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    kill = vi.fn();
}

interface Seen {
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    values: unknown;
    archive: Buffer | null;
}

/** A spawn stub that records what the render handed Helm, reading the files before they are removed. */
function fakeHelm(respond: (child: FakeChild) => void) {
    const seen: Seen[] = [];
    const spawn = vi.fn((_command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string }) => {
        const valuesFile = args[args.indexOf('--values') + 1]!;
        const archive = args[args.length - 1]!;
        seen.push({
            args,
            env: options.env,
            cwd: options.cwd,
            values: JSON.parse(readFileSync(valuesFile, 'utf8')) as unknown,
            archive: existsSync(archive) ? readFileSync(archive) : null,
        });
        const child = new FakeChild();
        queueMicrotask(() => respond(child));
        return child as never;
    });
    return { spawn: spawn as unknown as typeof import('node:child_process').spawn, seen };
}

const succeeds =
    (stdout: string): ((child: FakeChild) => void) =>
    (child) => {
        child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', 0);
    };

const helm = { path: '/opt/homebrew/bin/helm', version: '3.15.1' };
const capabilities: ChartCapabilities = {
    kubeVersion: 'v1.31.2+k3s1',
    apiVersions: ['v1', 'apps/v1', 'apps/v1/Deployment', 'example.com/v1'],
};
const release = { name: 'web', namespace: 'shop' };

const RENDERED = `---
# Source: demo/crds/widgets.yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: widgets.example.com

---
# Source: demo/templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: web-demo

---
# Source: demo/charts/db/templates/statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: web-db

---
# Source: demo/templates/tests/test-connection.yaml
apiVersion: v1
kind: Pod
metadata:
  name: web-demo-test
  annotations:
    "helm.sh/hook": test
---
# Source: demo/templates/migrate.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: web-migrate
  annotations:
    helm.sh/hook: pre-install, pre-upgrade
    helm.sh/hook-weight: "-5"
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
`;

let dir: string;
let archive: string;

beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'km-render-'));
    archive = path.join(dir, 'demo-0.1.0.tgz');
    writeFileSync(archive, gzipSync(Buffer.from('demo/templates/service.yaml\0{{ .Values.name }}')));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
});

describe('templateArgs', () => {
    it('asks for helm template alone, with the cluster capabilities and the CRDs, and never --validate', () => {
        const args = templateArgs('/scratch/values.json', '/charts/demo.tgz', capabilities, release);
        expect(args).toEqual([
            'template',
            '--namespace',
            'shop',
            '--include-crds',
            '--kube-version',
            'v1.31.2+k3s1',
            '--api-versions',
            'v1',
            '--api-versions',
            'apps/v1',
            '--api-versions',
            'apps/v1/Deployment',
            '--api-versions',
            'example.com/v1',
            '--values',
            '/scratch/values.json',
            '--',
            'web',
            '/charts/demo.tgz',
        ]);
        expect(args).not.toContain('--validate');
    });
});

describe('isCrdSource', () => {
    it('is the chart’s own crds/ directory or a subchart’s, never a template that merely sits in one', () => {
        expect(isCrdSource('demo/crds/widgets.yaml')).toBe(true);
        expect(isCrdSource('demo/charts/db/crds/backups.yaml')).toBe(true);
        expect(isCrdSource('demo/charts/db/charts/inner/crds/x.yaml')).toBe(true);
        expect(isCrdSource('demo/templates/crds/widgets.yaml')).toBe(false);
        expect(isCrdSource('demo/templates/service.yaml')).toBe(false);
        expect(isCrdSource('demo/charts/crds/templates/x.yaml')).toBe(false);
    });
});

describe('splitRendered', () => {
    it('splits objects, hooks with their events, weight and delete policy, and CRDs', () => {
        const split = splitRendered(RENDERED);
        expect(split.crds.map((one) => one.object.metadata.name)).toEqual(['widgets.example.com']);
        expect(split.objects.map((one) => [one.source, one.object.kind])).toEqual([
            ['demo/templates/service.yaml', 'Service'],
            ['demo/charts/db/templates/statefulset.yaml', 'StatefulSet'],
        ]);
        expect(split.hooks).toEqual([
            expect.objectContaining({
                source: 'demo/templates/tests/test-connection.yaml',
                events: ['test'],
                weight: 0,
                deletePolicies: [],
            }),
            expect.objectContaining({
                source: 'demo/templates/migrate.yaml',
                events: ['pre-install', 'pre-upgrade'],
                weight: -5,
                deletePolicies: ['before-hook-creation', 'hook-succeeded'],
            }),
        ]);
    });

    it('keeps each document’s own text and writes the release manifest the way Helm stores it', () => {
        const split = splitRendered(RENDERED);
        expect(split.objects[0]!.manifest).toBe('apiVersion: v1\nkind: Service\nmetadata:\n  name: web-demo');
        expect(split.manifest).toBe(
            '---\n# Source: demo/templates/service.yaml\napiVersion: v1\nkind: Service\nmetadata:\n  name: web-demo\n' +
                '---\n# Source: demo/charts/db/templates/statefulset.yaml\napiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: web-db\n',
        );
    });

    it('reads an unparseable weight as zero, as Helm does', () => {
        const split = splitRendered(
            '---\n# Source: c/templates/j.yaml\napiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n  annotations:\n    helm.sh/hook: post-install\n    helm.sh/hook-weight: soon\n',
        );
        expect(split.hooks[0]!.weight).toBe(0);
    });

    it('skips empty documents and output with no documents at all', () => {
        expect(splitRendered('')).toMatchObject({ objects: [], hooks: [], crds: [], manifest: '' });
        expect(splitRendered('---\n# Source: c/templates/empty.yaml\n\n---\n').objects).toEqual([]);
    });

    it('refuses a document with no kind, apiVersion or name, naming its template', () => {
        expect(() => splitRendered('---\n# Source: c/templates/odd.yaml\nfoo: bar\n')).toThrow(
            'c/templates/odd.yaml renders a document with no apiVersion, kind or name.',
        );
        expect(() => splitRendered('---\n# Source: c/templates/list.yaml\n- a\n- b\n')).toThrow(
            'c/templates/list.yaml',
        );
    });

    it('refuses output that is not YAML', () => {
        expect(() => splitRendered('---\n# Source: c/templates/bad.yaml\nkey: [unclosed\n')).toThrow(
            /c\/templates\/bad\.yaml is not valid YAML/,
        );
    });
});

describe('helmErrorMessage', () => {
    it('keeps Helm’s own sentence and drops its prefix and the --debug advice', () => {
        expect(
            helmErrorMessage(
                'Error: execution error at (demo/templates/req.yaml:1:25): fail must be unset\n\nUse --debug flag to render out invalid YAML\n',
            ),
        ).toBe('execution error at (demo/templates/req.yaml:1:25): fail must be unset');
        expect(helmErrorMessage('WARNING: something\nError: parse error at (c/templates/x.yaml:1)\n')).toBe(
            'parse error at (c/templates/x.yaml:1)',
        );
        expect(helmErrorMessage('')).toBe('Helm exited without saying why.');
    });
});

describe('usesLookup', () => {
    const chart = (body: string, name = 'demo/templates/x.yaml') => gzipOf([{ name, body }]);

    it('finds a lookup call in a template of the chart or of a subchart', async () => {
        await expect(usesLookup(chart('{{- $s := lookup "v1" "Secret" .Release.Namespace "x" }}'))).resolves.toBe(true);
        await expect(usesLookup(chart('{{ if (lookup "v1" "Namespace" "" "default") }}y{{ end }}'))).resolves.toBe(
            true,
        );
        await expect(
            usesLookup(chart('{{\n  lookup "v1" "Secret" "" ""\n}}', 'demo/charts/db/templates/_h.tpl')),
        ).resolves.toBe(true);
    });

    it('ignores the word outside an action and outside the templates', async () => {
        await expect(usesLookup(chart('{{ .Values.lookupTable }} lookup outside an action'))).resolves.toBe(false);
        await expect(usesLookup(chart('{{ lookup "v1" "Secret" "" "" }}', 'demo/README.md'))).resolves.toBe(false);
        await expect(usesLookup(Buffer.from('not gzip'))).resolves.toBe(false);
    });
});

describe('renderChart', () => {
    it('runs helm template on the archive with the values and answers the split result', async () => {
        const { spawn, seen } = fakeHelm(succeeds(RENDERED));
        const outcome = await renderChart(archive, { replicas: 2, image: { tag: '1.2' } }, capabilities, release, {
            helm,
            spawn,
        });
        expect(outcome).toMatchObject({ ok: true, render: { usesLookup: false } });
        if (!outcome.ok) return;
        expect(outcome.render.objects).toHaveLength(2);
        expect(outcome.render.hooks).toHaveLength(2);
        expect(outcome.render.crds).toHaveLength(1);
        expect(seen[0]!.values).toEqual({ replicas: 2, image: { tag: '1.2' } });
        expect(seen[0]!.args.slice(-2)).toEqual(['web', archive]);
        expect(seen[0]!.cwd).toBe(path.dirname(seen[0]!.env.KUBECONFIG!));
    });

    it('keeps the user’s kubeconfig and Helm configuration out of reach', async () => {
        const { spawn, seen } = fakeHelm(succeeds(''));
        await renderChart(archive, {}, capabilities, release, { helm, spawn });
        const { env, cwd } = seen[0]!;
        expect(env.KUBECONFIG).toBe(path.join(cwd, 'kubeconfig'));
        expect(env.HELM_CACHE_HOME).toBe(path.join(cwd, 'cache'));
        expect(env.HELM_CONFIG_HOME).toBe(path.join(cwd, 'config'));
        expect(env.HELM_DATA_HOME).toBe(path.join(cwd, 'data'));
        expect(Object.keys(env).filter((name) => name.startsWith('KUBE') || name.startsWith('HELM_'))).toHaveLength(5);
        expect(existsSync(cwd)).toBe(false);
    });

    it('renders archive bytes by writing them into the throwaway directory', async () => {
        const bytes = readFileSync(archive);
        const { spawn, seen } = fakeHelm(succeeds(''));
        await renderChart(bytes, {}, capabilities, release, { helm, spawn });
        const handed = seen[0]!.args[seen[0]!.args.length - 1]!;
        expect(path.dirname(handed)).toBe(seen[0]!.cwd);
        expect(seen[0]!.archive?.equals(bytes)).toBe(true);
    });

    it('says whether the chart uses lookup, which returns nothing without a cluster', async () => {
        writeFileSync(
            archive,
            gzipOf([{ name: 'demo/templates/x.yaml', body: '{{ $x := lookup "v1" "Secret" "" "" }}' }]),
        );
        const { spawn } = fakeHelm(succeeds(''));
        await expect(renderChart(archive, {}, capabilities, release, { helm, spawn })).resolves.toMatchObject({
            ok: true,
            render: { usesLookup: true },
        });
    });

    it('answers a template failure with Helm’s own message', async () => {
        const { spawn } = fakeHelm((child) => {
            child.stderr.emit(
                'data',
                Buffer.from('Error: execution error at (demo/templates/x.yaml:3:4): a host is required\n'),
            );
            child.emit('close', 1);
        });
        await expect(renderChart(archive, {}, capabilities, release, { helm, spawn })).resolves.toEqual({
            ok: false,
            error: {
                reason: 'template',
                message: 'execution error at (demo/templates/x.yaml:3:4): a host is required',
            },
        });
    });

    it('answers output it cannot split as a template failure', async () => {
        const { spawn } = fakeHelm(succeeds('---\n# Source: demo/templates/odd.yaml\nfoo: bar\n'));
        await expect(renderChart(archive, {}, capabilities, release, { helm, spawn })).resolves.toMatchObject({
            ok: false,
            error: { reason: 'template', message: expect.stringContaining('demo/templates/odd.yaml') },
        });
    });

    it('stops a render that runs too long or prints too much', async () => {
        const hung = fakeHelm(() => undefined);
        await expect(
            renderChart(archive, {}, capabilities, release, { helm, spawn: hung.spawn, timeoutMs: 20 }),
        ).resolves.toEqual({
            ok: false,
            error: { reason: 'timeout', message: 'Helm took longer than 0.02 seconds to render the chart.' },
        });

        const loud = fakeHelm((child) => child.stdout.emit('data', Buffer.alloc(64)));
        await expect(
            renderChart(archive, {}, capabilities, release, { helm, spawn: loud.spawn, maxOutputBytes: 32 }),
        ).resolves.toEqual({
            ok: false,
            error: { reason: 'tooLarge', message: 'The rendered chart is larger than the app will read.' },
        });
    });

    it('answers a Helm that cannot be started', async () => {
        const { spawn } = fakeHelm((child) => child.emit('error', new Error('spawn EACCES')));
        await expect(renderChart(archive, {}, capabilities, release, { helm, spawn })).resolves.toEqual({
            ok: false,
            error: { reason: 'helm', message: 'Helm could not be started: spawn EACCES' },
        });
    });

    it('answers no Helm on PATH without running anything', async () => {
        const { spawn } = fakeHelm(succeeds(''));
        await expect(
            renderChart(archive, {}, capabilities, release, { spawn, lookup: { env: {}, platform: 'darwin' } }),
        ).resolves.toEqual({
            ok: false,
            error: { reason: 'noHelm', message: 'Helm 3 or later is required to render a chart.' },
        });
        expect(spawn).not.toHaveBeenCalled();
    });

    it('refuses a release name, namespace or archive path Helm could read as something else', async () => {
        const { spawn } = fakeHelm(succeeds(''));
        const invalid = { ok: false, error: { reason: 'invalid', message: expect.any(String) } };
        await expect(
            renderChart(archive, {}, capabilities, { name: '--dry-run', namespace: 'shop' }, { helm, spawn }),
        ).resolves.toMatchObject(invalid);
        await expect(
            renderChart(archive, {}, capabilities, { name: 'x'.repeat(54), namespace: 'shop' }, { helm, spawn }),
        ).resolves.toMatchObject(invalid);
        await expect(
            renderChart(archive, {}, capabilities, { name: 'web', namespace: 'Shop' }, { helm, spawn }),
        ).resolves.toMatchObject(invalid);
        await expect(renderChart('demo-0.1.0.tgz', {}, capabilities, release, { helm, spawn })).resolves.toMatchObject(
            invalid,
        );
        await expect(
            renderChart(archive, {}, { ...capabilities, kubeVersion: 'latest' }, release, { helm, spawn }),
        ).resolves.toMatchObject(invalid);
        expect(spawn).not.toHaveBeenCalled();
    });

    it('answers an archive that cannot be read', async () => {
        const { spawn } = fakeHelm(succeeds(''));
        await expect(
            renderChart(path.join(dir, 'gone.tgz'), {}, capabilities, release, { helm, spawn }),
        ).resolves.toMatchObject({
            ok: false,
            error: { reason: 'invalid', message: 'The chart archive could not be read.' },
        });
    });
});
