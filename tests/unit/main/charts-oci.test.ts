import { describe, expect, it } from 'vitest';
import { chartLayerOf, HELM_CHART_LAYER, ociChartReference } from '../../../src/main/charts/oci';

const OP = 'charts.fetch';
const DIGEST = 'a'.repeat(64);

describe('ociChartReference', () => {
    it("addresses the chart under the registry's own path, at its version tag", () => {
        const reference = ociChartReference(OP, 'oci://ghcr.io/example/charts', 'nginx', '1.0.0');
        expect(reference.manifestUrl).toBe('https://ghcr.io/v2/example/charts/nginx/manifests/1.0.0');
        expect(reference.blobUrl(DIGEST)).toBe(`https://ghcr.io/v2/example/charts/nginx/blobs/sha256:${DIGEST}`);
    });

    it('keeps the port and reads a registry with no path at all', () => {
        expect(ociChartReference(OP, 'oci://reg.example.com:5000', 'nginx', '1.0.0').manifestUrl).toBe(
            'https://reg.example.com:5000/v2/nginx/manifests/1.0.0',
        );
        expect(ociChartReference(OP, 'oci://reg.example.com/org/', 'nginx', '1.0.0').manifestUrl).toBe(
            'https://reg.example.com/v2/org/nginx/manifests/1.0.0',
        );
    });

    it('writes the build separator as an underscore, the substitution helm push makes', () => {
        expect(ociChartReference(OP, 'oci://ghcr.io/x', 'nginx', '1.0.0+build.7').manifestUrl).toBe(
            'https://ghcr.io/v2/x/nginx/manifests/1.0.0_build.7',
        );
    });

    it('refuses a version no OCI tag can carry', () => {
        expect(() => ociChartReference(OP, 'oci://ghcr.io/x', 'nginx', `1.${'0'.repeat(200)}`)).toThrow(/OCI tag/);
        expect(() => ociChartReference(OP, 'oci://ghcr.io/x', 'nginx', '.1')).toThrow(/OCI tag/);
    });
});

describe('chartLayerOf', () => {
    const manifest = (layers: unknown[]) => ({
        schemaVersion: 2,
        config: { mediaType: 'application/vnd.cncf.helm.config.v1+json', digest: `sha256:${'b'.repeat(64)}` },
        layers,
    });

    it("finds the chart layer among the others by Helm's media type", () => {
        const layer = chartLayerOf(
            OP,
            manifest([
                {
                    mediaType: 'application/vnd.cncf.helm.chart.provenance.v1.prov',
                    digest: `sha256:${'c'.repeat(64)}`,
                    size: 9,
                },
                { mediaType: HELM_CHART_LAYER, digest: `sha256:${DIGEST}`, size: 4096 },
            ]),
        );
        expect(layer).toEqual({ digest: DIGEST, size: 4096 });
    });

    it('refuses a manifest with no chart layer, which is some other artifact', () => {
        for (const raw of [
            null,
            'text',
            {},
            manifest([]),
            manifest([
                { mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: `sha256:${DIGEST}`, size: 1 },
            ]),
        ]) {
            expect(() => chartLayerOf(OP, raw), JSON.stringify(raw)).toThrow(/other than a Helm chart/);
        }
    });

    it('refuses a chart layer whose digest cannot be checked or whose size is not a size', () => {
        expect(() =>
            chartLayerOf(OP, manifest([{ mediaType: HELM_CHART_LAYER, digest: 'sha512:abc', size: 1 }])),
        ).toThrow(/SHA-256/);
        for (const size of [undefined, -1, 1.5, '12']) {
            expect(() =>
                chartLayerOf(OP, manifest([{ mediaType: HELM_CHART_LAYER, digest: `sha256:${DIGEST}`, size }])),
            ).toThrow(/size/);
        }
    });
});
