import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ipc', () => ({ invoke: vi.fn(), subscribe: vi.fn() }));
const { describeUpdate, formatRelative, pillLabel } = await import('@/lib/updates');

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
        expect(describeUpdate({ status: 'downloading', version: '0.3.0', percent: 7 })).toEqual({
            title: 'Downloading version 0.3.0… 7%',
        });
        expect(describeUpdate({ status: 'downloaded', version: '0.3.0' }).title).toBe(
            'Version 0.3.0 is ready to install.',
        );
        expect(describeUpdate({ status: 'error', message: 'feed unreachable' })).toEqual({
            title: 'Update check failed.',
            detail: 'feed unreachable',
        });
    });

    it('prefers release notes over the release date for a found version', () => {
        expect(
            describeUpdate({ status: 'available', version: '0.3.0', notes: 'Fixes the namespace selector.' }),
        ).toEqual({
            title: 'Version 0.3.0 is available.',
            detail: 'Fixes the namespace selector.',
        });
        const dated = describeUpdate({
            status: 'available',
            version: '0.3.0',
            releaseDate: '2026-09-16T06:48:44.854Z',
        });
        expect(dated.detail).toMatch(/^Released .*2026\.$/);
        expect(
            describeUpdate({ status: 'available', version: '0.3.0', releaseDate: 'garbage' }).detail,
        ).toBeUndefined();
        expect(describeUpdate({ status: 'available' }).title).toBe('Version ? is available.');
    });
});
