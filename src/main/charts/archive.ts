import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { K8sError } from '../k8s/errors.js';

/**
 * A chart archive is a gzipped tar holding one directory, the chart, and everything the chart is
 * made of below it. Nothing here writes a file: the archive is read in memory, every entry is
 * checked before any of it is used, and only the three files the install screens read are kept.
 * The rendering step hands the archive itself to `helm template`, which is why an archive with
 * one unsafe entry is refused whole rather than read around.
 */

/** Ceiling on a downloaded archive. Real charts are kilobytes; the largest are a few megabytes. */
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;

/** Ceiling on what an archive may expand to, Helm's own `MaxDecompressedChartSize`. */
export const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;

const gunzipAsync = promisify(gunzip);

export function sha256Of(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/** What the install screens read from a chart; the rest of it is only ever `helm template`'s. */
export interface ChartFiles {
    chartYaml: string;
    valuesYaml: string | null;
    valuesSchema: string | null;
}

const KEPT = { 'Chart.yaml': 'chartYaml', 'values.yaml': 'valuesYaml', 'values.schema.json': 'valuesSchema' } as const;

/**
 * Why an entry's path could not be extracted safely, or null when it can. A backslash is read as
 * the separator a Windows-built archive means by it, so `..\\x` is caught as the `..` it is.
 */
export function entryPathProblem(name: string): string | null {
    const path = name.replaceAll('\\', '/');
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return `"${name}" is an absolute path.`;
    if (path.split('/').includes('..')) return `"${name}" reaches outside the chart.`;
    return null;
}

interface TarEntry {
    name: string;
    type: string;
    data: Buffer;
}

const BLOCK = 512;

function field(header: Buffer, start: number, length: number): string {
    const raw = header.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

function octal(op: string, header: Buffer, start: number, length: number): number {
    const text = field(header, start, length).trim();
    // Base-256 sizes (the high bit set) only ever mean an entry of eight gigabytes or more.
    if (!/^[0-7]*$/.test(text)) throw new K8sError('invalid', 'The chart archive is not a tar file.', op);
    return text ? parseInt(text, 8) : 0;
}

/** A header's checksum: its bytes summed with the checksum field itself counted as spaces. */
function checksumMatches(op: string, header: Buffer): boolean {
    let sum = 0;
    header.forEach((byte, i) => {
        sum += i >= 148 && i < 156 ? 0x20 : byte;
    });
    return sum === octal(op, header, 148, 8);
}

/** The `path` record of a pax extended header, which overrides the next entry's name. */
function paxPath(data: Buffer): string | undefined {
    let rest = data.toString('utf8');
    let path: string | undefined;
    while (rest.length > 0) {
        const space = rest.indexOf(' ');
        const length = parseInt(rest.slice(0, space), 10);
        if (space <= 0 || !Number.isFinite(length) || length <= space) break;
        const record = rest.slice(space + 1, length - 1);
        const equals = record.indexOf('=');
        if (record.slice(0, equals) === 'path') path = record.slice(equals + 1);
        rest = rest.slice(length);
    }
    return path;
}

/**
 * Every entry of a tar, long names resolved. The format is small enough to read by hand, which
 * keeps a runtime dependency out of main for the one thing it would be used for, and a reader
 * written here refuses what it does not understand instead of guessing at it.
 */
export function readTarEntries(op: string, tar: Buffer): TarEntry[] {
    const notTar = () => new K8sError('invalid', 'The chart archive is not a tar file.', op);
    const entries: TarEntry[] = [];
    let offset = 0;
    let longName: string | undefined;
    while (offset + BLOCK <= tar.length) {
        const header = tar.subarray(offset, offset + BLOCK);
        if (header.every((byte) => byte === 0)) return entries;
        if (!checksumMatches(op, header)) throw notTar();
        const size = octal(op, header, 124, 12);
        const type = field(header, 156, 1) || '0';
        const start = offset + BLOCK;
        if (start + size > tar.length) throw notTar();
        const data = tar.subarray(start, start + size);
        offset = start + Math.ceil(size / BLOCK) * BLOCK;
        if (type === 'x' || type === 'L') {
            longName = type === 'x' ? paxPath(data) : field(data, 0, data.length);
            continue;
        }
        if (type === 'g') continue;
        const prefix = field(header, 257, 6).startsWith('ustar') ? field(header, 345, 155) : '';
        const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
        longName = undefined;
        entries.push({ name, type, data });
    }
    // Two zero blocks end a tar; running out of bytes first is an archive cut short.
    throw notTar();
}

/**
 * Check a whole archive and read the chart's own files out of it. Like Helm's loader, the first
 * path segment is the chart's directory and is dropped, so a file sitting beside that directory is
 * outside the chart and refused. Links are refused too: a chart is made of files, and a link is
 * the one entry whose meaning depends on where the archive is unpacked.
 */
export async function readChartArchive(op: string, archive: Buffer): Promise<ChartFiles> {
    let tar: Buffer;
    try {
        tar = await gunzipAsync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
    } catch (error) {
        const tooLarge = error instanceof RangeError || (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE';
        throw new K8sError(
            'invalid',
            tooLarge
                ? `The chart archive expands past ${MAX_EXPANDED_BYTES / (1024 * 1024)} MB.`
                : 'The chart archive is not gzip-compressed.',
            op,
        );
    }
    const found: Partial<Record<keyof ChartFiles, string>> = {};
    for (const entry of readTarEntries(op, tar)) {
        const problem = entryPathProblem(entry.name);
        if (problem) throw new K8sError('invalid', `The chart archive is unsafe: ${problem}`, op);
        if (entry.type === '5') continue;
        if (entry.type !== '0' && entry.type !== '7') {
            throw new K8sError('invalid', `The chart archive is unsafe: "${entry.name}" is not a plain file.`, op);
        }
        const inChart = entry.name
            .replaceAll('\\', '/')
            .split('/')
            .filter((segment) => segment !== '' && segment !== '.')
            .slice(1)
            .join('/');
        if (!inChart) throw new K8sError('invalid', `The chart archive holds "${entry.name}" outside the chart.`, op);
        const key = KEPT[inChart as keyof typeof KEPT];
        if (key && found[key] === undefined) found[key] = entry.data.toString('utf8');
    }
    if (found.chartYaml === undefined) throw new K8sError('invalid', 'The archive holds no Chart.yaml.', op);
    return {
        chartYaml: found.chartYaml,
        valuesYaml: found.valuesYaml ?? null,
        valuesSchema: found.valuesSchema ?? null,
    };
}
