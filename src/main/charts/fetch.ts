import { load as loadYaml } from 'js-yaml';
import { CHART_NAME, CHART_VERSION, type ChartArchiveLocation, type ChartRepository } from '../../shared/charts.js';
import { K8sError, toK8sError } from '../k8s/errors.js';
import { MAX_ARCHIVE_BYTES, readChartArchive, sha256Of, type ChartFiles } from './archive.js';
import { archivePath, readArchive, readIndex, writeArchive } from './cache.js';
import { getCredential } from './credentials.js';
import { readCappedBytes, readCappedText } from './index-file.js';
import { chartLayerOf, MANIFEST_ACCEPT, ociChartReference } from './oci.js';
import { basicAuth, httpFailure, registryClient, type RegistryCredential } from './registry.js';
import { findChartRepository, readSource } from './repositories.js';

/**
 * Getting a chart archive onto disk, the first step of installing one. A classic repository's
 * index says where each version is published and what it hashes to; an OCI registry says both in
 * the manifest behind the version's tag. Either way the archive is checked against that digest and
 * read whole before it is cached, so the cache only ever holds archives that are safe to hand to
 * `helm template`, and a cached one is used without asking the network again.
 */

const OP = 'charts.fetch';

/** How long one archive or manifest download may take. */
const ARCHIVE_TIMEOUT_MS = 60_000;

/** A manifest is a few hundred bytes of JSON; past this it is not a manifest. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface FetchedChart extends ChartFiles {
    /** The cached archive, which the render step hands to `helm template`. */
    path: string;
    /** The archive's SHA-256 as bare hex. */
    digest: string;
}

/**
 * An index URL made absolute. A relative one resolves against the repository's address with a
 * trailing slash, as Helm resolves it, so `charts/nginx-1.0.0.tgz` under `https://host/repo` is
 * `https://host/repo/charts/nginx-1.0.0.tgz`; anything but http(s) is no download at all.
 */
export function resolveArchiveUrl(repositoryUrl: string, url: string): URL | null {
    try {
        const resolved = new URL(url, `${repositoryUrl.replace(/\/+$/, '')}/`);
        return resolved.protocol === 'https:' || resolved.protocol === 'http:' ? resolved : null;
    } catch {
        return null;
    }
}

/**
 * The repository's credential goes only to the repository's own origin. An index may list archives
 * on any host, and `helm pull` keeps the password from those unless told otherwise; so does this.
 */
function authFor(repositoryUrl: string, target: URL, credential: RegistryCredential | null) {
    return new URL(repositoryUrl).origin === target.origin ? basicAuth(credential) : {};
}

/** Where this version is published, refreshing the index once when the cached one does not say. */
async function locate(
    repository: ChartRepository,
    chart: string,
    version: string,
    credential: RegistryCredential | null,
) {
    const cached = readIndex(repository.name, repository.url)?.archives[chart]?.[version];
    if (cached) return cached;
    const location = (await readSource(OP, repository, credential)).archives[chart]?.[version];
    if (!location) throw new K8sError('notFound', `${chart} ${version} is not in ${repository.name}.`, OP);
    return location;
}

/**
 * Try each URL the index lists, in order. A mirror that fails or serves the wrong bytes is passed
 * over for the next one, and the last reason is the one reported when none of them serves the
 * archive the index describes.
 */
async function download(
    repository: ChartRepository,
    location: ChartArchiveLocation,
    credential: RegistryCredential | null,
) {
    let failure = new K8sError('invalid', 'The index lists no address this chart can be downloaded from.', OP);
    for (const url of location.urls) {
        const target = resolveArchiveUrl(repository.url, url);
        if (!target) continue;
        try {
            const response = await fetch(target, {
                headers: {
                    accept: 'application/gzip, application/octet-stream;q=0.9, */*;q=0.8',
                    ...authFor(repository.url, target, credential),
                },
                redirect: 'follow',
                signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
            });
            if (!response.ok) throw httpFailure(OP, response.status, 'The repository');
            const bytes = await readCappedBytes(OP, response, MAX_ARCHIVE_BYTES);
            const digest = sha256Of(bytes);
            if (location.digest && digest !== location.digest) {
                throw new K8sError('invalid', 'The downloaded archive does not match the digest its index lists.', OP);
            }
            return { bytes, digest };
        } catch (error) {
            failure = toK8sError(OP, error);
        }
    }
    throw failure;
}

async function fetchClassic(repository: ChartRepository, chart: string, version: string) {
    const credential = getCredential(repository.name);
    const location = await locate(repository, chart, version, credential);
    const cached = location.digest ? readArchive(repository.name, location.digest) : null;
    if (cached && location.digest) return { bytes: cached, digest: location.digest, cached: true };
    return { ...(await download(repository, location, credential)), cached: false };
}

async function fetchOci(repository: ChartRepository, chart: string, version: string) {
    const reference = ociChartReference(OP, repository.url, chart, version);
    const get = registryClient(getCredential(repository.name), ARCHIVE_TIMEOUT_MS);
    // A tag can be moved, so the manifest is always asked for; the archive it names is what caches.
    const answer = await get(reference.manifestUrl, { accept: MANIFEST_ACCEPT });
    if (answer.status === 404) throw new K8sError('notFound', `${chart} ${version} is not in ${repository.name}.`, OP);
    if (!answer.ok) throw httpFailure(OP, answer.status, 'The registry');
    let manifest: unknown;
    try {
        manifest = JSON.parse(await readCappedText(OP, answer, MAX_MANIFEST_BYTES));
    } catch (error) {
        if (error instanceof K8sError) throw error;
        throw new K8sError('invalid', 'The registry answered with something other than a manifest.', OP);
    }
    const layer = chartLayerOf(OP, manifest);
    const cached = readArchive(repository.name, layer.digest);
    if (cached) return { bytes: cached, digest: layer.digest, cached: true };
    if (layer.size > MAX_ARCHIVE_BYTES) {
        throw new K8sError('invalid', `The chart is larger than ${MAX_ARCHIVE_BYTES / (1024 * 1024)} MB.`, OP);
    }
    const blob = await get(reference.blobUrl(layer.digest));
    if (!blob.ok) throw httpFailure(OP, blob.status, 'The registry');
    const bytes = await readCappedBytes(OP, blob, MAX_ARCHIVE_BYTES);
    if (sha256Of(bytes) !== layer.digest) {
        throw new K8sError('invalid', 'The downloaded chart does not match the digest its manifest names.', OP);
    }
    return { bytes, digest: layer.digest, cached: false };
}

/**
 * The archive must be the chart that was asked for. An OCI tag can be pushed over with anything,
 * and a mis-generated index can point a version at another chart's archive; either would otherwise
 * be installed under the name the user picked.
 */
function assertIsChart(files: ChartFiles, chart: string, version: string): void {
    let metadata: unknown;
    try {
        metadata = loadYaml(files.chartYaml);
    } catch {
        throw new K8sError('invalid', 'The chart’s Chart.yaml is not YAML.', OP);
    }
    const { name, version: found } = (metadata ?? {}) as { name?: unknown; version?: unknown };
    if (name !== chart || String(found) !== version) {
        throw new K8sError(
            'invalid',
            `The archive holds ${String(name)} ${String(found)}, not ${chart} ${version}.`,
            OP,
        );
    }
}

/**
 * Fetch one version of a chart from a configured source, answering the cached archive's path and
 * the chart's own files. An archive is refused whole — never cached — when it fails its digest,
 * runs past the size ceilings, holds an entry outside the chart, or is some other chart.
 */
export async function fetchChart(source: string, chart: string, version: string): Promise<FetchedChart> {
    try {
        if (!CHART_NAME.test(chart)) throw new K8sError('invalid', `"${chart}" is not a chart name.`, OP);
        if (!CHART_VERSION.test(version)) throw new K8sError('invalid', `"${version}" is not a chart version.`, OP);
        const repository = findChartRepository(source, OP);
        const { bytes, digest, cached } =
            repository.kind === 'oci'
                ? await fetchOci(repository, chart, version)
                : await fetchClassic(repository, chart, version);
        const files = await readChartArchive(OP, bytes);
        assertIsChart(files, chart, version);
        const path = cached ? archivePath(repository.name, digest) : writeArchive(repository.name, digest, bytes);
        return { path, digest, ...files };
    } catch (error) {
        throw toK8sError(OP, error);
    }
}
