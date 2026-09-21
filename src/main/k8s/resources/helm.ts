import { gunzipSync, gzipSync } from 'node:zlib';
import { ApiException, type KubernetesObject, type V1Secret } from '@kubernetes/client-node';
import { dump as dumpYaml, loadAll as loadAllYaml } from 'js-yaml';
import type {
    HelmChart,
    Release,
    ReleaseRevision,
    ReleaseRollbackInput,
    ReleaseStatus,
    ReleaseUninstallInput,
    ReleaseWriteResult,
} from '../../../shared/k8s/addons.js';
import { isClusterScopedKindName } from '../../../shared/k8s/registry.js';
import { apis, listItems } from '../client.js';
import { K8sError, withK8s } from '../errors.js';
import { ago } from '../format.js';
import { assertContext } from './write.js';

/*
 * Helm keeps no API of its own: a release is a Secret of this type whose `release` field is
 * base64(gzip(json)), and one Secret exists per revision. Everything here is read-only decoding.
 */
const HELM_SECRET_TYPE = 'helm.sh/release.v1';
/** Ceiling for one decoded release. Secrets cap at about 1 MiB and gzip can inflate a thousandfold. */
const MAX_RELEASE_BYTES = 32 * 1024 * 1024;

interface HelmReleaseData {
    name?: string;
    namespace?: string;
    version?: number;
    info?: { status?: string; last_deployed?: string; description?: string };
    chart?: { metadata?: { name?: string; version?: string; appVersion?: string } };
    config?: Record<string, unknown>;
    /** The rendered manifests of this revision, as one multi-document YAML string. */
    manifest?: string;
}

const HELM_STATUS: Record<string, ReleaseStatus> = {
    deployed: 'Deployed',
    superseded: 'Superseded',
    failed: 'Failed',
    'pending-install': 'Progressing',
    'pending-upgrade': 'Progressing',
    'pending-rollback': 'Progressing',
    uninstalling: 'Terminating',
    uninstalled: 'Unknown',
};

export function helmStatus(status?: string): ReleaseStatus {
    return HELM_STATUS[status ?? ''] ?? 'Unknown';
}

/** The API base64-encodes Secret data, so the stored value is base64 twice over then gzipped. */
export function decodeRelease(secret: V1Secret): HelmReleaseData | null {
    const stored = secret.data?.release;
    if (!stored) return null;
    try {
        const gzipped = Buffer.from(Buffer.from(stored, 'base64').toString('utf8'), 'base64');
        return JSON.parse(
            gunzipSync(gzipped, { maxOutputLength: MAX_RELEASE_BYTES }).toString('utf8'),
        ) as HelmReleaseData;
    } catch {
        // Undecodable, or larger than any real release: a corrupt or hostile Secret is skipped, not inflated.
        return null;
    }
}

/**
 * Release Secrets: the explicit namespace when a caller has one, else the active selection, else
 * every namespace. The per-release reads always pass one, so a release is looked up where its
 * screen says it is rather than where the top bar happens to point.
 */
async function decodedReleases(namespace?: string): Promise<HelmReleaseData[]> {
    const fieldSelector = `type=${HELM_SECRET_TYPE}`;
    const { items } = await listItems(
        namespace,
        (ns) => apis().core.listNamespacedSecret({ namespace: ns, fieldSelector }),
        () => apis().core.listSecretForAllNamespaces({ fieldSelector }),
    );
    return items.map(decodeRelease).filter((release): release is HelmReleaseData => release !== null);
}

function chartLabel(release: HelmReleaseData): string {
    const meta = release.chart?.metadata;
    return meta?.name ? `${meta.name}-${meta.version ?? ''}` : '—';
}

/** What `helm get values` shows; undefined when the release runs on chart defaults alone. */
export function releaseValues(release: HelmReleaseData): string | undefined {
    const config = release.config;
    if (!config || Object.keys(config).length === 0) return undefined;
    try {
        return dumpYaml(config, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false });
    } catch {
        return undefined;
    }
}

/**
 * Longest manifest handed to the renderer. A Secret caps near 1 MiB compressed, so a chart with many
 * objects can decode to far more YAML than a panel can usefully show; the rest is cut rather than
 * sent, and the cut is stated in the manifest so nobody reads a partial document as the whole one.
 */
const MAX_MANIFEST_CHARS = 256 * 1024;

/** What `helm get manifest` shows; undefined when the revision rendered nothing. */
export function releaseManifest(release: HelmReleaseData): string | undefined {
    const manifest = release.manifest;
    if (!manifest?.trim()) return undefined;
    if (manifest.length <= MAX_MANIFEST_CHARS) return manifest;
    // Cut on a line boundary, so the last thing shown is a whole line rather than half a key.
    const cut = manifest.lastIndexOf('\n', MAX_MANIFEST_CHARS);
    const kept = manifest.slice(0, cut > 0 ? cut : MAX_MANIFEST_CHARS);
    return `${kept}\n# Manifest truncated: too large to show in full. Read an object's own Manifest tab for the rest.\n`;
}

/** What a detail read adds to a row, both of them the size of a chart rather than of a field. */
interface ReleaseDetail {
    values?: string;
    manifest?: string;
}

export function toRelease(release: HelmReleaseData, detail: ReleaseDetail = {}, now = Date.now()): Release {
    return {
        name: release.name ?? '',
        namespace: release.namespace ?? '',
        chart: chartLabel(release),
        revision: release.version ?? 0,
        status: helmStatus(release.info?.status),
        updated: ago(release.info?.last_deployed, now),
        values: detail.values,
        manifest: detail.manifest,
    };
}

/** One Secret per revision, so the current state is the highest revision of each release. */
export function latestPerRelease(releases: HelmReleaseData[]): HelmReleaseData[] {
    const byName = new Map<string, HelmReleaseData>();
    for (const release of releases) {
        const key = `${release.namespace}/${release.name}`;
        const existing = byName.get(key);
        if (!existing || (release.version ?? 0) > (existing.version ?? 0)) byName.set(key, release);
    }
    return [...byName.values()];
}

export function toRevisions(releases: HelmReleaseData[], now = Date.now()): ReleaseRevision[] {
    return [...releases]
        .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
        .map((release) => ({
            rev: String(release.version ?? 0),
            status: helmStatus(release.info?.status),
            chartVersion: release.chart?.metadata?.version ?? '—',
            updated: ago(release.info?.last_deployed, now),
            description: release.info?.description ?? '',
        }));
}

/** No repository index exists in a cluster, so the chart list is what the releases installed. */
export function toCharts(releases: HelmReleaseData[]): HelmChart[] {
    const byChart = new Map<string, HelmChart>();
    for (const release of latestPerRelease(releases)) {
        const meta = release.chart?.metadata;
        if (!meta?.name || byChart.has(meta.name)) continue;
        byChart.set(meta.name, {
            name: meta.name,
            repository: '—',
            latestVersion: meta.version ?? '—',
            appVersion: meta.appVersion ?? '—',
            description: release.info?.description ?? '',
        });
    }
    return [...byChart.values()];
}

function matching(releases: HelmReleaseData[], name: string, namespace: string): HelmReleaseData[] {
    return releases.filter((release) => release.name === name && release.namespace === namespace);
}

export function listReleases(): Promise<Release[]> {
    return withK8s('releases.list', async () => latestPerRelease(await decodedReleases()).map((r) => toRelease(r)));
}

export function getRelease(name: string, namespace: string): Promise<Release | null> {
    return withK8s('releases.get', async () => {
        const matches = matching(await decodedReleases(namespace), name, namespace);
        if (matches.length === 0) return null;
        const latest = matches.reduce((a, b) => ((b.version ?? 0) > (a.version ?? 0) ? b : a));
        return toRelease(latest, { values: releaseValues(latest), manifest: releaseManifest(latest) });
    });
}

export function getReleaseRevisions(name: string, namespace: string): Promise<ReleaseRevision[]> {
    return withK8s('releases.revisions', async () =>
        toRevisions(matching(await decodedReleases(namespace), name, namespace)),
    );
}

export function listHelmCharts(): Promise<HelmChart[]> {
    return withK8s('helmCharts.list', async () => toCharts(await decodedReleases()));
}

/*
 * Writes. Helm has no server side: rolling back and uninstalling mean acting on the objects a
 * revision rendered and then keeping its own bookkeeping Secrets straight. Both are written to be
 * recognisable to Helm itself — same Secret names, same labels, same status words — so a release
 * this app rolls back stays a release the Helm CLI can read and act on afterwards.
 */

/** Helm's name for one revision's Secret. */
export const releaseSecretName = (name: string, revision: number): string => `sh.helm.release.v1.${name}.v${revision}`;

/**
 * A rendered object the write path can actually address: without an apiVersion, a kind and a name
 * there is nothing to create, read or delete, so those are required rather than assumed.
 */
export type RenderedObject = KubernetesObject & {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace?: string; annotations?: Record<string, string> };
};

/** An object the chart asked to survive its release. */
const KEEP_POLICY_ANNOTATION = 'helm.sh/resource-policy';
export const isKept = (object: RenderedObject): boolean =>
    object.metadata.annotations?.[KEEP_POLICY_ANNOTATION] === 'keep';

/** The objects a revision rendered. Empty documents and anything without a kind are ignored. */
export function manifestObjects(manifest: string | undefined, namespace: string): RenderedObject[] {
    if (!manifest?.trim()) return [];
    let documents: unknown[];
    try {
        documents = loadAllYaml(manifest) as unknown[];
    } catch {
        // A manifest we cannot read is one we must not act on: better to do nothing than to guess.
        return [];
    }
    return documents
        .filter((doc): doc is RenderedObject => {
            const object = doc as RenderedObject | null;
            return (
                !!object &&
                typeof object === 'object' &&
                !!object.kind &&
                !!object.apiVersion &&
                !!object.metadata?.name
            );
        })
        .map((object) => {
            // Helm renders namespaced objects without a namespace and applies them into the
            // release's own; a cluster-scoped kind is never given one.
            if (!object.metadata.namespace && !isClusterScopedKindName(object.kind)) {
                object.metadata = { ...object.metadata, namespace };
            }
            return object;
        });
}

/** Identity of one rendered object, so two revisions' manifests can be compared. */
export const objectKey = (object: RenderedObject): string =>
    `${object.apiVersion}/${object.kind}/${object.metadata.namespace ?? ''}/${object.metadata.name}`;

/** What the old revision had and the new one does not: the objects a rollback takes away. */
export function goneBetween(from: RenderedObject[], to: RenderedObject[]): RenderedObject[] {
    const wanted = new Set(to.map(objectKey));
    return from.filter((object) => !wanted.has(objectKey(object)));
}

/** Store a release the way Helm does: gzipped JSON, base64 once here and once by the API. */
export function encodeRelease(release: HelmReleaseData): string {
    return gzipSync(Buffer.from(JSON.stringify(release), 'utf8')).toString('base64');
}

/** Every revision Secret of one release, newest first, with the data each carries. */
async function releaseSecrets(name: string, namespace: string): Promise<{ secret: V1Secret; data: HelmReleaseData }[]> {
    const { items } = await apis().core.listNamespacedSecret({
        namespace,
        fieldSelector: `type=${HELM_SECRET_TYPE}`,
    });
    return items
        .map((secret) => ({ secret, data: decodeRelease(secret) }))
        .filter((one): one is { secret: V1Secret; data: HelmReleaseData } => one.data?.name === name)
        .sort((a, b) => (b.data.version ?? 0) - (a.data.version ?? 0));
}

/** The Secret body for one revision, labelled the way Helm labels its own. */
function releaseSecretBody(data: HelmReleaseData): V1Secret {
    return {
        apiVersion: 'v1',
        kind: 'Secret',
        type: HELM_SECRET_TYPE,
        metadata: {
            name: releaseSecretName(data.name ?? '', data.version ?? 0),
            namespace: data.namespace,
            labels: {
                name: data.name ?? '',
                owner: 'helm',
                status: data.info?.status ?? 'unknown',
                version: String(data.version ?? 0),
            },
        },
        stringData: { release: encodeRelease(data) },
    };
}

/** Apply one rendered object: create it, or replace the one already there. */
async function applyObject(object: RenderedObject): Promise<void> {
    try {
        await apis().objects.create(object);
    } catch (error) {
        if (!(error instanceof ApiException) || error.code !== 409) throw error;
        // Already there: a replace needs the version it was read with, so read it first.
        const existing = await apis().objects.read(object);
        await apis().objects.replace({
            ...object,
            metadata: { ...object.metadata, resourceVersion: existing.metadata?.resourceVersion },
        });
    }
}

/** Delete one rendered object, treating one that is already gone as done. */
async function removeObject(object: RenderedObject): Promise<void> {
    try {
        await apis().objects.delete(object);
    } catch (error) {
        if (!(error instanceof ApiException) || error.code !== 404) throw error;
    }
}

/** Rewrite one revision's Secret with a new status, keeping everything else it holds. */
async function restatusRevision(secret: V1Secret, data: HelmReleaseData, status: string): Promise<void> {
    const next: HelmReleaseData = { ...data, info: { ...data.info, status } };
    await apis().core.replaceNamespacedSecret({
        name: secret.metadata!.name!,
        namespace: secret.metadata!.namespace!,
        body: {
            ...secret,
            metadata: { ...secret.metadata, labels: { ...secret.metadata?.labels, status } },
            data: undefined,
            stringData: { release: encodeRelease(next) },
        },
    });
}

/**
 * Roll a release back to one of its own revisions: re-apply that revision's rendered objects, take
 * away what it never had, and record the result as a new revision. Helm numbers forward through a
 * rollback rather than rewinding, and the description says where it came from, so the history reads
 * the same whether the Helm CLI or this app did it.
 */
export function rollbackRelease(input: ReleaseRollbackInput): Promise<ReleaseWriteResult> {
    const op = 'releases.rollback';
    return withK8s(op, async () => {
        assertContext(input.context, op);
        const revisions = await releaseSecrets(input.name, input.namespace);
        if (revisions.length === 0) {
            throw new K8sError('notFound', `No Helm release "${input.name}" in namespace ${input.namespace}.`, op);
        }
        const current = revisions[0]!;
        const target = revisions.find((one) => one.data.version === input.revision);
        if (!target) {
            throw new K8sError('notFound', `Release "${input.name}" has no revision ${input.revision}.`, op);
        }
        if (target.data.version === current.data.version) {
            throw new K8sError('invalid', `Release "${input.name}" already runs revision ${input.revision}.`, op);
        }

        const wanted = manifestObjects(target.data.manifest, input.namespace);
        const present = manifestObjects(current.data.manifest, input.namespace);
        for (const object of wanted) await applyObject(object);

        const removable = goneBetween(present, wanted);
        const kept = removable.filter(isKept);
        for (const object of removable.filter((one) => !isKept(one))) await removeObject(object);

        const revision = (current.data.version ?? 0) + 1;
        await apis().core.createNamespacedSecret({
            namespace: input.namespace,
            body: releaseSecretBody({
                ...target.data,
                version: revision,
                info: {
                    ...target.data.info,
                    status: 'deployed',
                    last_deployed: new Date().toISOString(),
                    description: `Rollback to ${input.revision}`,
                },
            }),
        });
        await restatusRevision(current.secret, current.data, 'superseded');

        return {
            name: input.name,
            namespace: input.namespace,
            revision,
            removed: removable.length - kept.length,
            kept: kept.length,
        };
    });
}

/**
 * Uninstall a release: delete the objects its current revision rendered, then either forget the
 * release entirely or keep its history marked uninstalled. Objects the chart annotated to be kept
 * are left where they are and counted, since that is the whole point of the annotation.
 */
export function uninstallRelease(input: ReleaseUninstallInput): Promise<ReleaseWriteResult> {
    const op = 'releases.uninstall';
    return withK8s(op, async () => {
        assertContext(input.context, op);
        const revisions = await releaseSecrets(input.name, input.namespace);
        if (revisions.length === 0) {
            throw new K8sError('notFound', `No Helm release "${input.name}" in namespace ${input.namespace}.`, op);
        }
        const current = revisions[0]!;
        const rendered = manifestObjects(current.data.manifest, input.namespace);
        const kept = rendered.filter(isKept);
        for (const object of rendered.filter((one) => !isKept(one))) await removeObject(object);

        if (input.keepHistory) {
            await restatusRevision(current.secret, current.data, 'uninstalled');
        } else {
            for (const { secret } of revisions) {
                await apis().core.deleteNamespacedSecret({
                    name: secret.metadata!.name!,
                    namespace: secret.metadata!.namespace!,
                });
            }
        }

        return {
            name: input.name,
            namespace: input.namespace,
            removed: rendered.length - kept.length,
            kept: kept.length,
        };
    });
}
