import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface Step {
    name?: string;
    run?: string;
    uses?: string;
}

const workflow = load(readFileSync('.github/workflows/release.yml', 'utf8')) as {
    jobs: Record<string, { needs?: string | string[]; steps?: Step[] }>;
};

const publish = workflow.jobs.publish!;
const steps = publish.steps ?? [];
const indexOf = (match: RegExp) => steps.findIndex((step) => match.test(step.name ?? ''));
const checksumStep = () => steps[indexOf(/checksum/i)];

describe('publishing a release', () => {
    it('runs only once every platform has packaged and verified its own uploads', () => {
        expect(publish.needs).toBe('package');
    });

    it('publishes checksums, which is the only place a combined file can be written', () => {
        expect(checksumStep()).toBeDefined();
        expect(checksumStep()?.run).toContain('SHA256SUMS');
        expect(checksumStep()?.run).toContain('gh release upload');
    });

    it('writes them before the release is public, so it is never visible without them', () => {
        const checksums = indexOf(/checksum/i);
        const madePublic = indexOf(/public and latest/i);
        expect(checksums).toBeGreaterThanOrEqual(0);
        expect(madePublic).toBeGreaterThanOrEqual(0);
        expect(checksums).toBeLessThan(madePublic);
    });

    it('takes the digests the upload already verified rather than hashing the assets again', () => {
        const run = checksumStep()?.run ?? '';
        expect(run).toContain('.digest');
        // Re-downloading every installer to hash it would move hundreds of megabytes for nothing.
        expect(run).not.toContain('gh release download');
    });

    it('checksums the installers and not the updater metadata beside them', () => {
        // Read the extensions out of the filter itself, so a comment mentioning one cannot pass this.
        const filter = /test\("\\\\\.\(([^)]+)\)\$"\)/.exec(checksumStep()?.run ?? '');
        expect(filter).not.toBeNull();
        const extensions = (filter?.[1] ?? '').split('|').sort();
        // The feeds are rewritten in place and the blockmaps are plumbing; neither is checked by hand.
        expect(extensions).toEqual(['AppImage', 'deb', 'dmg', 'exe', 'zip']);
    });
});
