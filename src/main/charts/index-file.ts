import type { ChartArchiveLocations, ChartSummary } from '../../shared/charts.js';
import { K8sError } from '../k8s/errors.js';

/**
 * A classic Helm repository's `index.yaml`: the one file that says what a repository holds. These
 * are pure transforms over the parsed document plus the one read that has to be bounded, so
 * everything about reading an index is testable without a network.
 */

/**
 * Ceiling on one index. The largest public repositories publish a few tens of megabytes; past this
 * the answer is not an index but something that would be held in memory whole before anyone found out.
 */
export const MAX_INDEX_BYTES = 32 * 1024 * 1024;

/** Where a repository publishes its index, whatever trailing slashes its URL was typed with. */
export function indexUrl(url: string): string {
    return `${url.replace(/\/+$/, '')}/index.yaml`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether this document is an index at all. A repository with no charts publishes `entries: {}`,
 * which is a legitimate empty index; a login page or an error page served with a 200 is not, and
 * must not be cached as a repository that happens to hold nothing.
 */
export function isChartIndexDocument(raw: unknown): boolean {
    return isRecord(raw) && isRecord(raw.entries);
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * One summary per chart, sorted by name. A chart's versions keep the order the index gives them,
 * which `helm repo index` writes newest first; reordering them here would mean ranking prerelease
 * tags by a comparison that does not understand them, which is a guess rather than a fix.
 */
export function parseChartIndex(raw: unknown): ChartSummary[] {
    if (!isChartIndexDocument(raw)) return [];
    const entries = (raw as { entries: Record<string, unknown> }).entries;
    const charts: ChartSummary[] = [];
    for (const [name, value] of Object.entries(entries)) {
        if (!Array.isArray(value)) continue;
        const published = value.filter(isRecord).filter((entry) => text(entry.version) !== '');
        const latest = published[0];
        if (!latest) continue;
        charts.push({
            name,
            latestVersion: text(latest.version),
            appVersion: text(latest.appVersion),
            description: text(latest.description),
            versions: published.map((entry) => text(entry.version)),
        });
    }
    return charts.sort((a, b) => a.name.localeCompare(b.name));
}

/** A SHA-256 digest as an index or a registry writes it, with or without its `sha256:` prefix. */
const SHA256 = /^(?:sha256:)?([a-f0-9]{64})$/;

/** The bare hex of a SHA-256 digest, or null for anything else. */
export function sha256Hex(value: unknown): string | null {
    return typeof value === 'string' ? (SHA256.exec(value.trim().toLowerCase())?.[1] ?? null) : null;
}

/**
 * Where each version of each chart is published and what its archive must hash to. The URLs are
 * kept as the index wrote them, relative ones included, because what they resolve against is the
 * repository's address at the moment of the download, not at the moment of the refresh.
 */
export function parseChartArchives(raw: unknown): ChartArchiveLocations {
    if (!isChartIndexDocument(raw)) return {};
    const entries = (raw as { entries: Record<string, unknown> }).entries;
    const archives: ChartArchiveLocations = {};
    for (const [name, value] of Object.entries(entries)) {
        if (!Array.isArray(value)) continue;
        const versions: ChartArchiveLocations[string] = {};
        for (const entry of value.filter(isRecord)) {
            const version = text(entry.version);
            const urls = Array.isArray(entry.urls) ? entry.urls.filter((url) => typeof url === 'string' && url) : [];
            if (!version || urls.length === 0 || version in versions) continue;
            versions[version] = { urls, digest: sha256Hex(entry.digest) };
        }
        if (Object.keys(versions).length > 0) archives[name] = versions;
    }
    return archives;
}

/**
 * The body, refusing anything past `max`. The announced length is checked first, and the stream is
 * then read a chunk at a time so a server that announces nothing cannot make the app hold an
 * unbounded response either.
 */
export async function readCappedBytes(op: string, response: Response, max: number): Promise<Buffer> {
    const tooLarge = () => new K8sError('invalid', `The answer is larger than ${max / (1024 * 1024)} MB.`, op);
    const announced = Number(response.headers.get('content-length'));
    if (Number.isFinite(announced) && announced > max) throw tooLarge();
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > max) throw tooLarge();
            chunks.push(value);
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks, size);
}

/** The body as text, capped as {@link readCappedBytes} caps it. */
export async function readCappedText(op: string, response: Response, max = MAX_INDEX_BYTES): Promise<string> {
    return (await readCappedBytes(op, response, max)).toString('utf8');
}
