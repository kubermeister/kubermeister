import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHART_REPOSITORY_NAME, chartIndexSchema, type ChartIndex } from '../../shared/charts.js';

/**
 * Each classic repository's index, cached in Electron's `userData`. An index is a download of tens
 * of megabytes for the larger repositories, so it is read once per refresh and kept on disk rather
 * than fetched again every time something asks what a repository holds.
 *
 * The cache is only ever a cache: a missing, corrupt or stale file means "not refreshed yet", never
 * an error, and a write failure is logged rather than thrown.
 */

function indexDir(): string {
    return join(app.getPath('userData'), 'chart-index');
}

/**
 * The cache file for a repository. The name is re-checked here rather than trusted from the caller:
 * this is the one place a repository name becomes a path, so it is the place that must hold.
 */
function indexPath(name: string): string {
    if (!CHART_REPOSITORY_NAME.test(name)) throw new Error(`"${name}" is not a chart repository name`);
    return join(indexDir(), `${name}.json`);
}

/** The cached index for this repository, or null unless one was written for the URL it still names. */
export function readIndex(name: string, url: string): ChartIndex | null {
    const path = indexPath(name);
    try {
        const parsed = chartIndexSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
        if (!parsed.success) return null;
        // A repository that has been re-pointed since keeps its name; its old index is not its index.
        return parsed.data.url === url ? parsed.data : null;
    } catch {
        return null;
    }
}

export function writeIndex(name: string, index: ChartIndex): void {
    const path = indexPath(name);
    try {
        mkdirSync(indexDir(), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(index), 'utf8');
        renameSync(tmp, path);
    } catch (error) {
        console.error(`[charts] failed to cache the index for "${name}"`, error);
    }
}

export function removeIndex(name: string): void {
    rmSync(indexPath(name), { force: true });
}

/**
 * Downloaded chart archives, one directory per repository under `chart-cache` and one file per
 * archive named by its SHA-256. An archive is immutable once its digest is known, so a cached one is
 * never refreshed, only checked; the directory per repository is what lets removing a repository
 * take everything it downloaded with it, and what keeps an archive fetched with one repository's
 * credential from being answered for another's.
 */

const SHA256_HEX = /^[a-f0-9]{64}$/;

function archiveDir(name: string): string {
    if (!CHART_REPOSITORY_NAME.test(name)) throw new Error(`"${name}" is not a chart repository name`);
    return join(app.getPath('userData'), 'chart-cache', name);
}

export function archivePath(name: string, digest: string): string {
    if (!SHA256_HEX.test(digest)) throw new Error(`"${digest}" is not a SHA-256 digest`);
    return join(archiveDir(name), `${digest}.tgz`);
}

/**
 * The cached archive with this digest, or null. The bytes are hashed again on the way out: a file
 * cut short by a crash or changed on disk is a miss that downloads again, never a chart that is not
 * the one its digest names.
 */
export function readArchive(name: string, digest: string): Buffer | null {
    try {
        const bytes = readFileSync(archivePath(name, digest));
        return createHash('sha256').update(bytes).digest('hex') === digest ? bytes : null;
    } catch {
        return null;
    }
}

/** Cache an archive whose digest the caller has checked; answers where it now lives. */
export function writeArchive(name: string, digest: string, bytes: Buffer): string {
    const path = archivePath(name, digest);
    mkdirSync(archiveDir(name), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
    return path;
}

export function removeArchives(name: string): void {
    rmSync(archiveDir(name), { recursive: true, force: true });
}
