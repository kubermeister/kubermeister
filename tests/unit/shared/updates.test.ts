import { describe, expect, it } from 'vitest';
import { compareVersions, releaseFeedUrl, releasePageUrl, REPOSITORY_URL } from '../../../src/shared/updates';

describe('release urls', () => {
    it('points a version at its release tag', () => {
        expect(releasePageUrl('0.2.1')).toBe(`${REPOSITORY_URL}/releases/tag/v0.2.1`);
    });

    it('points each platform at the feed the release workflow publishes for it', () => {
        expect(releaseFeedUrl('linux')).toBe(`${REPOSITORY_URL}/releases/latest/download/latest-linux.yml`);
        expect(releaseFeedUrl('darwin')).toBe(`${REPOSITORY_URL}/releases/latest/download/latest-mac.yml`);
        expect(releaseFeedUrl('win32')).toBe(`${REPOSITORY_URL}/releases/latest/download/latest.yml`);
    });
});

describe('comparing versions', () => {
    it('orders by major, then minor, then patch', () => {
        expect(compareVersions('0.5.0', '0.4.9')).toBeGreaterThan(0);
        expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
        // Numbers, not text: 10 is past 9 where a string comparison would say otherwise.
        expect(compareVersions('0.4.10', '0.4.9')).toBeGreaterThan(0);
        expect(compareVersions('0.4.9', '0.5.0')).toBeLessThan(0);
        expect(compareVersions('0.4.9', '0.4.9')).toBe(0);
    });

    it('reads a tag the same as the version inside it', () => {
        expect(compareVersions('v0.5.0', '0.5.0')).toBe(0);
        expect(compareVersions(' 0.5.0 ', '0.5.0')).toBe(0);
    });

    it('treats a missing or unreadable part as zero rather than giving up', () => {
        expect(compareVersions('1', '1.0.0')).toBe(0);
        expect(compareVersions('1.2', '1.2.0')).toBe(0);
        expect(compareVersions('1.2.x', '1.2.0')).toBe(0);
    });
});
