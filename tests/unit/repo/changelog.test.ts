import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const contributing = readFileSync('CONTRIBUTING.md', 'utf8');
const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');

/** Every `## [x]` heading, which is Unreleased followed by the released versions, newest first. */
const versionHeadings = [...changelog.matchAll(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?$/gm)];

/** Keep a Changelog's own six, and nothing invented beside them. */
const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

describe('changelog', () => {
    it('always has an Unreleased section at the top for the next change to land in', () => {
        expect(versionHeadings[0]?.[1]).toBe('Unreleased');
    });

    it('dates every released version and leaves Unreleased undated', () => {
        for (const [, version, date] of versionHeadings) {
            if (version === 'Unreleased') expect(date).toBeUndefined();
            else expect(date, version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
    });

    it('sorts its entries under the sections Keep a Changelog defines', () => {
        const headings = [...changelog.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
        for (const heading of headings) expect(SECTIONS).toContain(heading);
    });

    it('writes no issue or pull request numbers, which the generated notes already carry', () => {
        const entries = changelog.split('\n').filter((line) => line.startsWith('- '));
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) expect(entry, entry).not.toMatch(/#\d+/);
    });

    it('is a rule a contributor can read before it is one an agent follows', () => {
        expect(contributing).toContain('CHANGELOG.md');
        expect(contributing).toContain('## [Unreleased]');
    });

    it('is linked from the release notes rather than replacing them', () => {
        expect(releaseWorkflow).toContain('CHANGELOG.md');
        // The generated list of pull requests stays; the link is prepended above it.
        expect(releaseWorkflow).toContain('--generate-notes');
    });
});
