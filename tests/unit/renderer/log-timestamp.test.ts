import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatLogTimestamp } from '@/lib/log-timestamp';

// Node reads TZ again whenever it changes, so each test can stand in a zone of its choosing.
let zone: string | undefined;
beforeEach(() => {
    zone = process.env.TZ;
});
afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
});

describe('log timestamps', () => {
    it('shows the API server’s stamp in the reader’s zone, to the millisecond, with the offset', () => {
        process.env.TZ = 'Asia/Yerevan';
        expect(formatLogTimestamp('2026-10-01T11:46:59.091078241Z')).toBe('2026-10-01T15:46:59.091+04:00');
    });

    it('names a zone behind UTC with a minus, and one with half hours in full', () => {
        process.env.TZ = 'America/New_York';
        expect(formatLogTimestamp('2026-01-15T03:00:00.5Z')).toBe('2026-01-14T22:00:00.500-05:00');
        process.env.TZ = 'Asia/Kolkata';
        expect(formatLogTimestamp('2026-01-15T03:00:00Z')).toBe('2026-01-15T08:30:00.000+05:30');
    });

    it('reads a stamp written with an offset of its own', () => {
        process.env.TZ = 'UTC';
        expect(formatLogTimestamp('2026-10-01T13:46:59.5+02:00')).toBe('2026-10-01T11:46:59.500+00:00');
    });

    it('shows anything that is not RFC 3339 as it came, and nothing as nothing', () => {
        expect(formatLogTimestamp('')).toBe('');
        expect(formatLogTimestamp('yesterday')).toBe('yesterday');
        expect(formatLogTimestamp('2026-13-45T99:99:99Z')).toBe('2026-13-45T99:99:99Z');
    });
});
