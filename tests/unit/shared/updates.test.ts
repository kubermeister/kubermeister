import { describe, expect, it } from 'vitest';
import { releasePageUrl, REPOSITORY_URL } from '../../../src/shared/updates';

describe('releasePageUrl', () => {
    it('points a version at its release tag', () => {
        expect(releasePageUrl('0.2.1')).toBe(`${REPOSITORY_URL}/releases/tag/v0.2.1`);
    });
});
