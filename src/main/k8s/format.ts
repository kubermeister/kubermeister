import type { V1LabelSelector } from '@kubernetes/client-node';

/**
 * Pure display-formatting helpers that map raw Kubernetes field values into the strings/numbers
 * the renderer models expect. No cluster access — kept here so they are unit-testable in isolation.
 */

const SECOND = 1;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact, kubectl-style age from a creation timestamp, e.g. "58m", "1h42m", "2d20h", "34d". */
export function age(creationTimestamp?: string | Date | null, now: number = Date.now()): string {
    if (!creationTimestamp) return '—';
    const created = new Date(creationTimestamp).getTime();
    if (Number.isNaN(created)) return '—';
    const secs = Math.max(0, Math.floor((now - created) / 1000));
    const d = Math.floor(secs / DAY);
    const h = Math.floor((secs % DAY) / HOUR);
    const m = Math.floor((secs % HOUR) / MINUTE);
    const s = secs % MINUTE;
    if (d > 0) return d < 7 && h > 0 ? `${d}d${h}h` : `${d}d`;
    if (h > 0) return h < 10 && m > 0 ? `${h}h${m}m` : `${h}h`;
    if (m > 0) return `${m}m`;
    return `${s * SECOND}s`;
}

/** Relative "… ago" phrasing for last-scheduled / event-style fields. */
export function ago(timestamp?: string | Date | null, now: number = Date.now()): string {
    const a = age(timestamp, now);
    return a === '—' ? '—' : `${a} ago`;
}

/** "X/Y" ready ratio. */
export function readyRatio(ready: number | undefined, total: number | undefined): string {
    return `${ready ?? 0}/${total ?? 0}`;
}

/** Falls back to an em-dash for empty/missing display values. */
export function dash(value?: string | null): string {
    return value && value.length > 0 ? value : '—';
}

/**
 * Split a Kubernetes quantity into its numeric value and unit suffix. The numeric part accepts an
 * optional decimal exponent (`"129e6"`, `"1e3"`, `"1.5E9"`); a real unit suffix never begins with a
 * digit, so the exponent (`[eE][±]digits`) is unambiguously distinct from the `E`/`Ei` suffixes.
 * Returns `null` for empty/malformed input (so callers fall back to 0).
 */
const QUANTITY_PATTERN = /^([+-]?[0-9.]+(?:[eE][-+]?[0-9]+)?)([A-Za-z]+)?$/;

function parseQuantity(quantity?: string | null): { value: number; suffix: string } | null {
    if (!quantity) return null;
    const match = quantity.trim().match(QUANTITY_PATTERN);
    if (!match) return null;
    const value = Number(match[1]);
    if (Number.isNaN(value)) return null;
    return { value, suffix: match[2] ?? '' };
}

/**
 * The multiplier of every suffix a Kubernetes quantity may carry: the decimal SI ones (lower-case
 * `k` is kilo, `m` milli) and the binary ones. Anything else is not a quantity, so it reads as
 * `null` rather than as a plain number.
 */
const QUANTITY_SUFFIX: Record<string, number> = {
    '': 1,
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
};

/** A quantity in its base unit (cores, bytes, objects), or `null` when it is not a quantity. */
function quantityValue(quantity?: string | null): number | null {
    const parsed = parseQuantity(quantity);
    if (!parsed) return null;
    const multiplier = QUANTITY_SUFFIX[parsed.suffix];
    return multiplier === undefined ? null : parsed.value * multiplier;
}

/** Parse a Kubernetes CPU quantity ("250m", "1", "1500000000n", "2u", "1e3", "1k") to millicores. */
export function cpuToMillicores(quantity?: string | null): number {
    const cores = quantityValue(quantity);
    return cores === null ? 0 : Math.round(cores * 1000);
}

/** Parse a Kubernetes memory quantity ("512Mi", "1Gi", "1500k", "536870912", "129e6") to bytes. */
export function memToBytes(quantity?: string | null): number {
    const bytes = quantityValue(quantity);
    return bytes === null ? 0 : Math.round(bytes);
}

/** Memory quantity → whole MiB (used for pod usage figures). */
export function memToMi(quantity?: string | null): number {
    return Math.round(memToBytes(quantity) / 1024 ** 2);
}

/** Memory quantity → GiB with one decimal (used for node capacity figures). */
export function memToGiB(quantity?: string | null): number {
    return Math.round((memToBytes(quantity) / 1024 ** 3) * 10) / 10;
}

/** CPU quantity → whole cores (used for node capacity figures). */
export function cpuToCores(quantity?: string | null): number {
    return Math.round(cpuToMillicores(quantity) / 1000);
}

/** Compact duration between two timestamps, e.g. "38s", "2m18s", "1h2m". */
export function duration(start?: string | Date | null, end?: string | Date | null): string {
    if (!start) return '—';
    const from = new Date(start).getTime();
    const to = end ? new Date(end).getTime() : Date.now();
    if (Number.isNaN(from) || Number.isNaN(to)) return '—';
    const secs = Math.max(0, Math.floor((to - from) / 1000));
    const h = Math.floor(secs / HOUR);
    const m = Math.floor((secs % HOUR) / MINUTE);
    const s = secs % MINUTE;
    if (h > 0) return `${h}h${m}m`;
    if (m > 0) return `${m}m${s}s`;
    return `${s}s`;
}

/** Human-readable byte size in binary units, e.g. "618 B", "2.1 KiB", "188 KiB". */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Render a label/selector map as "k=v,k=v", or a fallback when empty. */
export function joinSelector(selector?: Record<string, string> | null, empty = '<none>'): string {
    const entries = Object.entries(selector ?? {});
    if (entries.length === 0) return empty;
    return entries.map(([k, v]) => `${k}=${v}`).join(',');
}

const EXPRESSION_FORMS: Record<string, (key: string, values: string) => string> = {
    In: (key, values) => `${key} in (${values})`,
    NotIn: (key, values) => `${key} notin (${values})`,
    Exists: (key) => key,
    DoesNotExist: (key) => `!${key}`,
};

/**
 * A label selector in kubectl's syntax, `matchLabels` and `matchExpressions` both, e.g.
 * "app=web,tier notin (front)". An empty selector and an absent one mean opposite things (every pod
 * versus none, for the kinds that allow both), so each has its own word.
 */
export function formatLabelSelector(
    selector: V1LabelSelector | null | undefined,
    words: { everything: string; nothing: string },
): string {
    if (!selector) return words.nothing;
    const parts = [
        ...Object.entries(selector.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`),
        ...(selector.matchExpressions ?? []).map(({ key, operator, values }) => {
            const form = EXPRESSION_FORMS[operator];
            return form ? form(key, (values ?? []).join(',')) : `${key} ${operator} (${(values ?? []).join(',')})`;
        }),
    ];
    return parts.length === 0 ? words.everything : parts.join(',');
}

/**
 * Numeric value of a Kubernetes quantity in the resource's natural unit: cpu → millicores,
 * memory/storage → bytes, anything else (object counts like `pods`/`services`) → the raw number.
 * Keyed on the quota/limit resource name because the unit is implied by the key, not the value.
 */
export function quantityToNumber(resource: string, value?: string | null): number {
    if (!value) return 0;
    if (resource.includes('cpu')) return cpuToMillicores(value);
    if (resource.includes('memory') || resource.includes('storage')) return memToBytes(value);
    return Math.round(quantityValue(value) ?? 0);
}

/**
 * Remaining headroom (`hard − used`, clamped at 0) for a quota resource, rendered in that resource's
 * natural unit — cores for cpu, a binary byte size for memory/storage, a plain count otherwise.
 * Returns an em-dash when there is no hard ceiling to measure against.
 */
export function formatQuantityDelta(resource: string, hard?: string | null, used?: string | null): string {
    if (!hard) return dash(hard);
    const remaining = Math.max(0, quantityToNumber(resource, hard) - quantityToNumber(resource, used));
    if (resource.includes('cpu')) {
        // remaining is in millicores; show whole/fractional cores unless it's a sub-core amount.
        if (remaining >= 1000 || remaining % 1000 === 0) return String(Math.round(remaining / 10) / 100);
        return `${remaining}m`;
    }
    if (resource.includes('memory') || resource.includes('storage')) return formatBytes(remaining);
    return String(remaining);
}

const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

/** Label or annotation pairs, minus the last-applied blob that would dwarf everything else. */
export function toPairs(record?: Record<string, string>): Array<[string, string]> {
    return Object.entries(record ?? {}).filter(([key]) => key !== LAST_APPLIED);
}
