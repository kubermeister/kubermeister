import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/**
 * Chart archives built by hand, so a test can write exactly the entry an attack would carry — an
 * absolute path, a `..`, a link — which no well-behaved tar tool would produce on request.
 */

export interface FixtureEntry {
    name: string;
    body?: string;
    /** The tar type flag: `0` a file, `5` a directory, `1` a hard link, `2` a symlink. */
    type?: string;
    /** Written into the ustar prefix field rather than the name. */
    prefix?: string;
    /** Carried in a pax extended header before the entry, which overrides its name. */
    paxPath?: string;
    /** Carried in a GNU long-name entry before the entry. */
    gnuLongName?: string;
}

function header(name: string, size: number, type: string, prefix = ''): Buffer {
    const block = Buffer.alloc(512);
    block.write(name.slice(0, 100), 0, 'utf8');
    block.write('0000644\0', 100);
    block.write('0000000\0', 108);
    block.write('0000000\0', 116);
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    block.write('00000000000\0', 136);
    block.write('        ', 148);
    block.write(type, 156);
    block.write('ustar\0', 257);
    block.write('00', 263);
    if (prefix) block.write(prefix, 345, 'utf8');
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return block;
}

function record(data: Buffer, name: string, type: string, prefix?: string): Buffer[] {
    const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
    return [header(name, data.length, type, prefix), data, padding];
}

function paxRecord(key: string, value: string): string {
    const body = ` ${key}=${value}\n`;
    let length = body.length;
    while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
    return `${length}${body}`;
}

export function tarOf(entries: FixtureEntry[]): Buffer {
    const parts: Buffer[] = [];
    for (const entry of entries) {
        if (entry.paxPath !== undefined) {
            parts.push(...record(Buffer.from(paxRecord('path', entry.paxPath)), 'PaxHeader', 'x'));
        }
        if (entry.gnuLongName !== undefined) {
            parts.push(...record(Buffer.from(`${entry.gnuLongName}\0`), '././@LongLink', 'L'));
        }
        parts.push(...record(Buffer.from(entry.body ?? ''), entry.name, entry.type ?? '0', entry.prefix));
    }
    parts.push(Buffer.alloc(1024));
    return Buffer.concat(parts);
}

export function gzipOf(entries: FixtureEntry[]): Buffer {
    return gzipSync(tarOf(entries));
}

export const NGINX_CHART_YAML = 'apiVersion: v2\nname: nginx\nversion: 1.0.0\nappVersion: "1.27"\n';

/** A small, well-formed chart the way `helm package` lays one out. */
export function nginxChart(extra: FixtureEntry[] = [], chartYaml = NGINX_CHART_YAML): Buffer {
    return gzipOf([
        { name: 'nginx/', type: '5' },
        { name: 'nginx/Chart.yaml', body: chartYaml },
        { name: 'nginx/values.yaml', body: '# How many pods\nreplicaCount: 1\n' },
        { name: 'nginx/values.schema.json', body: '{"type":"object"}' },
        { name: 'nginx/templates/deployment.yaml', body: 'kind: Deployment\n' },
        ...extra,
    ]);
}

export function sha256(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}
