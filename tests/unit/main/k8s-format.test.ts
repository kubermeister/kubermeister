import { describe, it, expect } from 'vitest';
import {
    age,
    ago,
    cpuToCores,
    cpuToMillicores,
    dash,
    duration,
    formatBytes,
    formatQuantityDelta,
    joinSelector,
    memToBytes,
    memToGiB,
    memToMi,
    quantityToNumber,
    readyRatio,
    toPairs,
} from '../../../src/main/k8s/format';

const NOW = Date.parse('2026-05-29T12:00:00Z');
const before = (ms: number) => new Date(NOW - ms).toISOString();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('age', () => {
    it('formats sub-minute, minute, hour, and day spans', () => {
        expect(age(before(30 * SECOND), NOW)).toBe('30s');
        expect(age(before(58 * MINUTE), NOW)).toBe('58m');
        expect(age(before(HOUR + 42 * MINUTE), NOW)).toBe('1h42m');
        expect(age(before(18 * HOUR), NOW)).toBe('18h');
        expect(age(before(2 * DAY + 20 * HOUR), NOW)).toBe('2d20h');
        expect(age(before(34 * DAY), NOW)).toBe('34d');
    });

    it('returns an em-dash for missing or invalid timestamps', () => {
        expect(age(undefined, NOW)).toBe('—');
        expect(age('not-a-date', NOW)).toBe('—');
    });
});

describe('ago / readyRatio / dash', () => {
    it('appends a suffix to a relative age', () => {
        expect(ago(new Date(NOW - 22 * HOUR).toISOString(), NOW)).toBe('22h ago');
    });

    it('renders X/Y ratios with zero fallbacks', () => {
        expect(readyRatio(18, 18)).toBe('18/18');
        expect(readyRatio(undefined, undefined)).toBe('0/0');
    });

    it('falls back to an em-dash for empty values', () => {
        expect(dash('nginx')).toBe('nginx');
        expect(dash('')).toBe('—');
        expect(dash(undefined)).toBe('—');
    });
});

describe('cpu quantity parsing', () => {
    it('parses millicores from every unit', () => {
        expect(cpuToMillicores('250m')).toBe(250);
        expect(cpuToMillicores('1')).toBe(1000);
        expect(cpuToMillicores('1500000000n')).toBe(1500);
        expect(cpuToMillicores('500000u')).toBe(500);
        expect(cpuToMillicores(undefined)).toBe(0);
    });

    it('handles scientific notation and malformed input', () => {
        expect(cpuToMillicores('1e3')).toBe(1_000_000);
        expect(cpuToMillicores('1.5e0')).toBe(1500);
        expect(cpuToMillicores('not-a-number')).toBe(0);
    });

    it('reads the decimal multiplier suffixes and refuses unknown ones', () => {
        expect(cpuToMillicores('1k')).toBe(1_000_000);
        expect(cpuToMillicores('2M')).toBe(2_000_000_000);
        expect(cpuToMillicores('1500000000n')).toBe(1500);
        expect(cpuToMillicores('1Ki')).toBe(1_024_000);
        expect(cpuToMillicores('1K')).toBe(0);
        expect(cpuToMillicores('3x')).toBe(0);
    });

    it('converts to whole cores', () => {
        expect(cpuToCores('2000m')).toBe(2);
        expect(cpuToCores('4')).toBe(4);
    });
});

describe('memory quantity parsing', () => {
    it('parses binary and decimal suffixes to bytes', () => {
        expect(memToBytes('1Ki')).toBe(1024);
        expect(memToBytes('1Mi')).toBe(1024 ** 2);
        expect(memToBytes('512')).toBe(512);
        expect(memToBytes('1M')).toBe(1_000_000);
    });

    it('parses scientific notation (not the E/Ei suffixes) to bytes', () => {
        expect(memToBytes('129e6')).toBe(129_000_000);
        expect(memToBytes('1e3')).toBe(1000);
        expect(memToBytes('1E3')).toBe(1000);
        expect(memToBytes('1E')).toBe(1e18);
        expect(memToBytes('2Ei')).toBe(2 * 1024 ** 6);
        expect(memToBytes('garbage')).toBe(0);
    });

    it('reads the lower-case kilo and the milli suffix the API server canonicalises to', () => {
        expect(memToBytes('1500k')).toBe(1_500_000);
        expect(memToBytes('1k')).toBe(1000);
        expect(memToBytes('128974848000m')).toBe(128_974_848);
        expect(memToBytes('2000000u')).toBe(2);
        expect(memToBytes('3000000000n')).toBe(3);
    });

    it('refuses suffixes Kubernetes does not define rather than reading them as bytes', () => {
        expect(memToBytes('1K')).toBe(0);
        expect(memToBytes('5X')).toBe(0);
        expect(memToBytes('1ki')).toBe(0);
    });

    it('converts to MiB and GiB', () => {
        expect(memToMi('1Gi')).toBe(1024);
        expect(memToMi('536870912')).toBe(512);
        expect(memToGiB('2Gi')).toBe(2);
    });
});

describe('duration / formatBytes / joinSelector', () => {
    it('formats a span between two timestamps', () => {
        const start = new Date(NOW - (2 * MINUTE + 18 * SECOND)).toISOString();
        const end = new Date(NOW).toISOString();
        expect(duration(start, end)).toBe('2m18s');
        expect(duration(undefined)).toBe('—');
    });

    it('formats byte sizes in binary units', () => {
        expect(formatBytes(618)).toBe('618 B');
        expect(formatBytes(2150)).toBe('2.1 KiB');
        expect(formatBytes(200 * 1024)).toBe('200 KiB');
    });

    it('renders selectors and a fallback', () => {
        expect(joinSelector({ role: 'db', tier: 'data' })).toBe('role=db,tier=data');
        expect(joinSelector({})).toBe('<none>');
        expect(joinSelector(null, '<all pods>')).toBe('<all pods>');
    });
});

describe('quantityToNumber / formatQuantityDelta', () => {
    it('reads a quantity in the resource-implied unit', () => {
        expect(quantityToNumber('cpu', '500m')).toBe(500);
        expect(quantityToNumber('limits.cpu', '2')).toBe(2000);
        expect(quantityToNumber('requests.memory', '1Mi')).toBe(1024 ** 2);
        expect(quantityToNumber('requests.storage', '1Gi')).toBe(1024 ** 3);
        expect(quantityToNumber('pods', '10')).toBe(10);
        expect(quantityToNumber('services', undefined)).toBe(0);
        expect(quantityToNumber('requests.memory', '1500k')).toBe(1_500_000);
        expect(quantityToNumber('limits.cpu', '1k')).toBe(1_000_000);
        expect(quantityToNumber('pods', '1k')).toBe(1000);
        expect(quantityToNumber('count/configmaps', '2k')).toBe(2000);
        expect(quantityToNumber('pods', 'lots')).toBe(0);
    });

    it('formats quota headroom in the resource unit', () => {
        expect(formatQuantityDelta('cpu', '4', '1200m')).toBe('2.8');
        expect(formatQuantityDelta('limits.cpu', '2', '1500m')).toBe('500m');
        expect(formatQuantityDelta('requests.memory', '1Gi', '512Mi')).toBe('512 MiB');
        expect(formatQuantityDelta('pods', '20', '7')).toBe('13');
        expect(formatQuantityDelta('requests.memory', '2M', '1500k')).toBe('488 KiB');
        expect(formatQuantityDelta('pods', '1k', '400')).toBe('600');
    });

    it('clamps at zero and falls back with no hard ceiling', () => {
        expect(formatQuantityDelta('cpu', '1', '2')).toBe('0');
        expect(formatQuantityDelta('pods', '5', '5')).toBe('0');
        expect(formatQuantityDelta('cpu', undefined, '1')).toBe('—');
        expect(formatQuantityDelta('cpu', '')).toBe('—');
    });

    it('turns label maps into pairs and drops the last-applied blob', () => {
        expect(toPairs({ app: 'web', 'kubectl.kubernetes.io/last-applied-configuration': '{}' })).toEqual([
            ['app', 'web'],
        ]);
        expect(toPairs(undefined)).toEqual([]);
    });
});
