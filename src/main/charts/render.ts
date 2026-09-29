import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { DNS_LABEL } from '../../shared/k8s/names.js';
import type { RenderedObject } from '../k8s/resources/helm.js';
import { loadRenderedYaml } from '../k8s/yaml.js';
import { MAX_EXPANDED_BYTES, readTarEntries } from './archive.js';
import {
    HELM_TIMEOUT_MS,
    findHelm,
    isolatedHelmEnv,
    runHelm,
    withHelmHome,
    type HelmBinary,
    type HelmLookupOptions,
} from './helm-cli.js';

/**
 * Rendering is `helm template` and nothing else: the archive and the values go in, YAML comes out,
 * and the result is split the way an install needs it — the objects, the hooks with the annotations
 * that order them, and the CRDs from `crds/` that go first. What the chart is told about the cluster
 * comes from the caller, read through the app's own client, because the Helm child has no cluster
 * to ask: its kubeconfig is an empty file. That is also why `lookup` answers nothing here, exactly
 * as it does in any `helm template`, and why `--validate`, which would ask a cluster, is never
 * passed.
 */

const gunzipAsync = promisify(gunzip);

/** What a chart's `.Capabilities` answer for: the cluster it is being rendered for. */
export interface ChartCapabilities {
    /** The API server's `gitVersion`, e.g. `v1.31.2+k3s1`. */
    kubeVersion: string;
    /** Every served group-version and group-version/Kind, as Helm's own discovery lists them. */
    apiVersions: string[];
}

export interface ReleaseInfo {
    name: string;
    namespace: string;
    /** Rendered for an upgrade of a release that exists, so `.Release.IsUpgrade` answers true, as in `helm upgrade`. */
    upgrade?: boolean;
}

export interface RenderedManifest {
    /** The template it came from, as Helm's `# Source:` line names it. */
    source: string;
    /** The document's own text, which the release Secret stores. */
    manifest: string;
    object: RenderedObject;
}

export interface RenderedHook extends RenderedManifest {
    events: string[];
    weight: number;
    /** As the chart wrote them. Helm applies `before-hook-creation` itself when there are none. */
    deletePolicies: string[];
}

export interface ChartRender {
    objects: RenderedManifest[];
    hooks: RenderedHook[];
    crds: RenderedManifest[];
    /** The objects as Helm stores them in a release's `manifest`: no hooks and no CRDs. */
    manifest: string;
    /** Whether a template calls `lookup`, which rendered nothing because there was no cluster. */
    usesLookup: boolean;
}

export type RenderErrorReason = 'template' | 'timeout' | 'tooLarge' | 'helm' | 'noHelm' | 'invalid';

export interface RenderError {
    reason: RenderErrorReason;
    message: string;
}

export type RenderOutcome = { ok: true; render: ChartRender } | { ok: false; error: RenderError };

export interface RenderOptions {
    /** The binary to run; looked up on PATH when omitted. */
    helm?: HelmBinary;
    lookup?: HelmLookupOptions;
    spawn?: HelmLookupOptions['spawn'];
    timeoutMs?: number;
    maxOutputBytes?: number;
}

/** Helm's own limit on a release name, which also names Secrets and labels. */
const MAX_RELEASE_NAME = 53;

/** A version `--kube-version` accepts: SemVer with an optional `v`, as `/version` reports it. */
const KUBE_VERSION = /^v?\d+\.\d+(\.\d+)?([-+][0-9A-Za-z.+-]*)?$/;

const HOOK_ANNOTATION = 'helm.sh/hook';
const HOOK_WEIGHT_ANNOTATION = 'helm.sh/hook-weight';
const HOOK_DELETE_ANNOTATION = 'helm.sh/hook-delete-policy';

/**
 * The arguments for one render. Flags come first and `--` ends them, so neither the release name
 * nor the archive path can ever be read as a flag, whatever they hold.
 */
export function templateArgs(
    valuesFile: string,
    archive: string,
    capabilities: ChartCapabilities,
    release: ReleaseInfo,
): string[] {
    return [
        'template',
        '--namespace',
        release.namespace,
        '--include-crds',
        ...(release.upgrade ? ['--is-upgrade'] : []),
        '--kube-version',
        capabilities.kubeVersion,
        ...capabilities.apiVersions.flatMap((version) => ['--api-versions', version]),
        '--values',
        valuesFile,
        '--',
        release.name,
        archive,
    ];
}

/**
 * The directory a chart file sits in, below its chart or the subchart that holds it: `templates`
 * for `web/charts/db/templates/x.yaml`. Helm names every rendered file this way, and so does the
 * archive once its top directory is counted as the chart.
 */
function chartDirectory(file: string): string | undefined {
    const parts = file.split('/');
    let at = 1;
    while (parts[at] === 'charts' && at + 2 < parts.length) at += 2;
    return parts[at];
}

/** Whether a rendered file came from a chart's `crds/` directory, a subchart's included. */
export function isCrdSource(source: string): boolean {
    return chartDirectory(source) === 'crds';
}

function isRenderedObject(value: unknown): value is RenderedObject {
    const object = value as RenderedObject | null;
    return (
        !!object &&
        typeof object === 'object' &&
        !Array.isArray(object) &&
        typeof object.apiVersion === 'string' &&
        typeof object.kind === 'string' &&
        typeof object.metadata?.name === 'string'
    );
}

const listOf = (value: string | undefined): string[] =>
    (value ?? '')
        .split(',')
        .map((one) => one.trim())
        .filter(Boolean);

/**
 * Split `helm template` output into what an install applies. Helm heads every document with
 * `---` and a `# Source:` line; a document that is not an addressable object is refused naming its
 * template, since installing around it would leave the release short of something it rendered.
 */
export function splitRendered(output: string): Omit<ChartRender, 'usesLookup'> {
    const split: Omit<ChartRender, 'usesLookup'> = { objects: [], hooks: [], crds: [], manifest: '' };
    for (const chunk of output.split(/^---[ \t]*$/m)) {
        const lines = chunk.replace(/^\n+/, '').split('\n');
        const heading = /^# Source: (.+)$/.exec(lines[0] ?? '');
        const source = heading?.[1]?.trim() ?? 'the chart';
        const manifest = (heading ? lines.slice(1) : lines).join('\n').trim();
        if (!manifest) continue;
        let document: unknown;
        try {
            document = loadRenderedYaml(manifest);
        } catch (error) {
            throw new Error(`${source} is not valid YAML: ${(error as Error).message}`, { cause: error });
        }
        if (document === null || document === undefined) continue;
        if (!isRenderedObject(document)) {
            throw new Error(`${source} renders a document with no apiVersion, kind or name.`);
        }
        const rendered = { source, manifest, object: document };
        const annotations = document.metadata.annotations ?? {};
        if (isCrdSource(source)) {
            split.crds.push(rendered);
        } else if (listOf(annotations[HOOK_ANNOTATION]).length > 0) {
            const weight = Number.parseInt(annotations[HOOK_WEIGHT_ANNOTATION] ?? '', 10);
            split.hooks.push({
                ...rendered,
                events: listOf(annotations[HOOK_ANNOTATION]),
                // Helm reads a weight it cannot parse as zero rather than refusing the chart.
                weight: Number.isNaN(weight) ? 0 : weight,
                deletePolicies: listOf(annotations[HOOK_DELETE_ANNOTATION]),
            });
        } else {
            split.objects.push(rendered);
            split.manifest += `---\n# Source: ${source}\n${manifest}\n`;
        }
    }
    return split;
}

/**
 * Helm's own words for a failed render — a `required` value, a template that does not parse —
 * without the `Error:` it prefixes and the advice about `--debug`, which is no use to somebody
 * editing values in a form. The lines after `Error:` are kept, one per line: a schema failure lists
 * every value it refuses there, and a template that fails on a value names it there, which is what
 * lets the values editor put each on the value it is about.
 */
export function helmErrorMessage(stderr: string): string {
    const lines = stderr.split('\n').map((line) => line.trim());
    const start = lines.findIndex((line) => line.startsWith('Error:'));
    const kept = (start === -1 ? lines : lines.slice(start)).filter((line) => line && !line.startsWith('Use --debug'));
    if (start !== -1) kept[0] = kept[0]!.slice('Error:'.length).trim();
    const message = kept.filter(Boolean).join(start === -1 ? ' ' : '\n');
    return message || 'Helm exited without saying why.';
}

/**
 * Whether any template of the chart or its subcharts calls `lookup` inside an action. The review
 * says so, because such a chart rendered without the objects it looked for. An archive that cannot
 * be read has already failed the render, so it answers false here.
 */
export async function usesLookup(archive: Buffer): Promise<boolean> {
    try {
        const tar = await gunzipAsync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
        return readTarEntries('charts.render', tar).some(
            (entry) =>
                chartDirectory(entry.name.replaceAll('\\', '/')) === 'templates' &&
                /\{\{[^}]*\blookup\b/.test(entry.data.toString('utf8')),
        );
    } catch {
        return false;
    }
}

function refuse(reason: RenderErrorReason, message: string): RenderOutcome {
    return { ok: false, error: { reason, message } };
}

function inputProblem(archive: string | Buffer, capabilities: ChartCapabilities, release: ReleaseInfo): string | null {
    if (release.name.length > MAX_RELEASE_NAME || !DNS_LABEL.test(release.name)) {
        return `"${release.name}" is not a release name: lowercase letters, digits and dashes, at most ${MAX_RELEASE_NAME}.`;
    }
    if (!DNS_LABEL.test(release.namespace)) return `"${release.namespace}" is not a namespace name.`;
    if (!KUBE_VERSION.test(capabilities.kubeVersion))
        return `"${capabilities.kubeVersion}" is not a Kubernetes version.`;
    // A relative path is what Helm reads as `repository/chart` and would go looking for.
    if (typeof archive === 'string' && !path.isAbsolute(archive)) return 'The chart archive must be an absolute path.';
    return null;
}

/**
 * Render a chart archive — its cached path or its bytes — with the given values, for the given
 * cluster and release. Never throws: a chart that does not render is an answer the values editor
 * shows, carrying Helm's own message, and no Helm is an answer the screens describe.
 */
export async function renderChart(
    archive: string | Buffer,
    values: Record<string, unknown>,
    capabilities: ChartCapabilities,
    release: ReleaseInfo,
    options: RenderOptions = {},
): Promise<RenderOutcome> {
    const problem = inputProblem(archive, capabilities, release);
    if (problem) return refuse('invalid', problem);

    let bytes: Buffer;
    try {
        bytes = typeof archive === 'string' ? await readFile(archive) : archive;
    } catch {
        return refuse('invalid', 'The chart archive could not be read.');
    }

    const helm = options.helm ?? (await findHelm({ ...options.lookup, spawn: options.spawn }));
    if (!helm) return refuse('noHelm', 'Helm 3 or later is required to render a chart.');

    const timeoutMs = options.timeoutMs ?? HELM_TIMEOUT_MS;
    const run = await withHelmHome(async (home) => {
        const valuesFile = path.join(home, 'values.json');
        await writeFile(valuesFile, JSON.stringify(values), { mode: 0o600 });
        let chart = archive;
        if (typeof chart !== 'string') {
            chart = path.join(home, 'chart.tgz');
            await writeFile(chart, bytes);
        }
        return runHelm(helm.path, templateArgs(valuesFile, chart, capabilities, release), {
            env: isolatedHelmEnv(home, options.lookup?.platform, options.lookup?.env),
            cwd: home,
            spawn: options.spawn,
            timeoutMs,
            maxOutputBytes: options.maxOutputBytes,
        });
    });

    if (!run.ok) {
        if (run.failure === 'timeout') {
            return refuse('timeout', `Helm took longer than ${timeoutMs / 1000} seconds to render the chart.`);
        }
        if (run.failure === 'tooLarge')
            return refuse('tooLarge', 'The rendered chart is larger than the app will read.');
        return refuse('helm', `Helm could not be started: ${run.message}`);
    }
    if (run.code !== 0) return refuse('template', helmErrorMessage(run.stderr));

    try {
        return { ok: true, render: { ...splitRendered(run.stdout), usesLookup: await usesLookup(bytes) } };
    } catch (error) {
        return refuse('template', (error as Error).message);
    }
}
