import { K8sError } from '../k8s/errors.js';
import { sha256Hex } from './index-file.js';

/**
 * A chart in an OCI registry is an image manifest whose one meaningful layer is the chart archive.
 * `helm push` writes it that way, and `helm pull` reads it back by asking for the manifest at the
 * chart's version tag and then for the layer of Helm's own media type. These are the pure parts of
 * that read: the addresses and what a manifest has to say before its blob is worth downloading.
 */

export const HELM_CHART_LAYER = 'application/vnd.cncf.helm.chart.content.v1.tar+gzip';

/** Helm pushes an OCI image manifest; the Docker v2 type is accepted for registries that relabel it. */
export const MANIFEST_ACCEPT =
    'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json;q=0.9';

/** An OCI tag's grammar, which a Helm version fits once its `+` build separator is swapped for `_`. */
const OCI_TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export interface OciChartReference {
    manifestUrl: string;
    blobUrl: (digest: string) => string;
}

/**
 * Where a chart's manifest and blobs live. The registry's own path is kept, so `oci://ghcr.io/org`
 * holding `nginx` is the repository `org/nginx`; the tag is the version with `+` written as `_`,
 * since an OCI tag cannot carry a `+` and that is the substitution `helm push` makes.
 */
export function ociChartReference(op: string, url: string, chart: string, version: string): OciChartReference {
    const parsed = new URL(url);
    const tag = version.replaceAll('+', '_');
    if (!OCI_TAG.test(tag)) throw new K8sError('invalid', `"${version}" cannot be an OCI tag.`, op);
    const path = [...parsed.pathname.split('/').filter(Boolean), chart].join('/');
    const base = `https://${parsed.host}/v2/${path}`;
    return {
        manifestUrl: `${base}/manifests/${encodeURIComponent(tag)}`,
        blobUrl: (digest) => `${base}/blobs/sha256:${digest}`,
    };
}

export interface ChartLayer {
    /** The layer's SHA-256 as bare hex, which the archive cache is keyed by. */
    digest: string;
    size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The chart layer a manifest names. A manifest without one is some other artifact stored under the
 * chart's name — an image, a signature — and is refused rather than having its first layer read as
 * a chart; a layer whose digest is not SHA-256 cannot be checked after the download, so it is
 * refused too.
 */
export function chartLayerOf(op: string, raw: unknown): ChartLayer {
    const layers = isRecord(raw) && Array.isArray(raw.layers) ? raw.layers.filter(isRecord) : [];
    const layer = layers.find((candidate) => candidate.mediaType === HELM_CHART_LAYER);
    if (!layer) throw new K8sError('invalid', 'The registry holds something other than a Helm chart there.', op);
    const digest = sha256Hex(layer.digest);
    if (!digest) throw new K8sError('invalid', 'The chart layer names no SHA-256 digest.', op);
    const { size } = layer;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
        throw new K8sError('invalid', 'The chart layer names no size.', op);
    }
    return { digest, size };
}
