import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ipc', () => ({ invoke: vi.fn(), subscribe: vi.fn() }));
const { describeUpdate, formatBytes, formatRelative, pillLabel } = await import('@/lib/updates');

const NOW = Date.parse('2026-09-16T07:00:00.000Z');

describe('pillLabel', () => {
    it('stays hidden for states that ask nothing of the user', () => {
        expect(pillLabel(null)).toBeNull();
        for (const status of ['idle', 'checking', 'up-to-date', 'unsupported'] as const) {
            expect(pillLabel({ status })).toBeNull();
        }
        expect(pillLabel({ status: 'error', message: 'offline', background: true })).toBeNull();
    });

    it('names the step the user can take', () => {
        expect(pillLabel({ status: 'available', version: '0.3.0' })).toEqual({
            label: 'Update available',
            tone: 'accent',
        });
        expect(pillLabel({ status: 'downloading', percent: 42 })).toEqual({
            label: 'Downloading 42%',
            tone: 'neutral',
        });
        expect(pillLabel({ status: 'downloading' })).toEqual({ label: 'Downloading 0%', tone: 'neutral' });
        expect(pillLabel({ status: 'downloaded', version: '0.3.0' })).toEqual({
            label: 'Restart to update',
            tone: 'accent',
        });
        expect(pillLabel({ status: 'error', message: 'offline' })).toEqual({ label: 'Update failed', tone: 'danger' });
    });

    it('shows a version the user installs by hand the same as one the app can fetch', () => {
        // The pill says a version exists; what it costs to get it is the popover's business.
        expect(pillLabel({ status: 'manual', version: '0.5.0' })).toEqual({
            label: 'Update available',
            tone: 'accent',
        });
    });
});

describe('formatBytes', () => {
    it('steps up a unit at a time and keeps one decimal past a kilobyte', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1024)).toBe('1.0 KB');
        expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
        expect(formatBytes(8.25 * 1024 * 1024)).toBe('8.3 MB');
        expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
    });

    it('stops at gigabytes rather than naming a unit nobody downloads', () => {
        expect(formatBytes(2048 * 1024 * 1024)).toBe('2.0 GB');
    });
});

describe('formatRelative', () => {
    it('rounds down to the coarsest unit that fits and falls back to the date', () => {
        expect(formatRelative('2026-09-16T06:59:40.000Z', NOW)).toBe('just now');
        expect(formatRelative('2026-09-16T06:55:01.000Z', NOW)).toBe('4 min ago');
        expect(formatRelative('2026-09-16T04:00:00.000Z', NOW)).toBe('3 h ago');
        expect(formatRelative('2026-09-10T07:00:00.000Z', NOW)).toMatch(/2026/);
        expect(formatRelative('2026-09-16T08:00:00.000Z', NOW)).toBe('just now');
        expect(formatRelative('not a date', NOW)).toBe('not a date');
    });
});

describe('describeUpdate', () => {
    it('describes every state in a sentence', () => {
        expect(describeUpdate(null).title).toBe('Loading update status…');
        expect(describeUpdate({ status: 'unsupported', message: 'Development build' })).toEqual({
            title: 'In-app updates are unavailable here.',
            detail: 'Development build',
        });
        expect(describeUpdate({ status: 'idle' })).toEqual({ title: 'Not checked yet.' });
        expect(describeUpdate({ status: 'checking' })).toEqual({ title: 'Checking for updates…' });
        expect(describeUpdate({ status: 'up-to-date', checkedAt: '2026-09-16T06:50:00.000Z' }, NOW)).toEqual({
            title: "You're on the latest version.",
            detail: 'Checked 10 min ago.',
        });
        expect(describeUpdate({ status: 'up-to-date' })).toEqual({ title: "You're on the latest version." });
        expect(
            describeUpdate({ status: 'manual', version: '0.5.0', message: 'This package is managed by the system.' }),
        ).toEqual({
            title: 'Version 0.5.0 is available.',
            detail: 'This package is managed by the system.',
        });
        expect(describeUpdate({ status: 'downloading', version: '0.3.0', percent: 7 })).toEqual({
            title: 'Downloading version 0.3.0… 7%',
        });
        // A differential download's total is the size of the change, which is the point of showing it.
        expect(
            describeUpdate({
                status: 'downloading',
                version: '0.3.0',
                percent: 66,
                transferred: 8 * 1024 * 1024,
                total: 12 * 1024 * 1024,
            }),
        ).toEqual({ title: 'Downloading version 0.3.0… 66%', detail: '8.0 MB of 12.0 MB' });
        // A transferred count past the total would read as more than all of it.
        expect(
            describeUpdate({ status: 'downloading', version: '0.3.0', percent: 100, transferred: 99, total: 50 })
                .detail,
        ).toBe('50 B of 50 B');
        expect(describeUpdate({ status: 'downloaded', version: '0.3.0' }).title).toBe(
            'Version 0.3.0 is ready to install.',
        );
        expect(describeUpdate({ status: 'error', message: 'feed unreachable' })).toEqual({
            title: 'Update check failed.',
            detail: 'feed unreachable',
        });
    });

    it('dates a found version rather than reciting its changelog', () => {
        const dated = describeUpdate({
            status: 'available',
            version: '0.3.0',
            releaseDate: '2026-09-16T06:48:44.854Z',
        });
        expect(dated.detail).toMatch(/^Released .*2026\.$/);
        expect(dated.title).toBe('Version 0.3.0 is available.');
        expect(
            describeUpdate({ status: 'available', version: '0.3.0', releaseDate: 'garbage' }).detail,
        ).toBeUndefined();
        expect(describeUpdate({ status: 'available' }).title).toBe('Version ? is available.');
    });
});
