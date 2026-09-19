import { describe, expect, it } from 'vitest';
import { releaseNotesText } from '../../../src/main/release-notes.js';

// What GitHub's Atom feed carries for a release whose notes were generated on the releases page.
const GITHUB_BODY = `<h2>What's Changed</h2>
<ul>
<li>fix(k8s): tell an unreachable cluster from a slow one by <a class="user-mention notranslate" data-hovercard-type="user" href="https://github.com/araratpoghosyan">@araratpoghosyan</a> in <a class="issue-link js-issue-link" data-error-text="Failed to load title" href="https://github.com/kubermeister/kubermeister/pull/101">#101</a></li>
<li>perf(k8s): stop listing every pod to draw list screens by <a href="https://github.com/araratpoghosyan">@araratpoghosyan</a> in <a href="https://github.com/kubermeister/kubermeister/pull/102">#102</a></li>
</ul>
<p><strong>Full Changelog</strong>: <a class="commit-link" href="https://github.com/kubermeister/kubermeister/compare/v0.4.0...v0.4.1"><tt>v0.4.0...v0.4.1</tt></a></p>`;

describe('releaseNotesText', () => {
    it('turns GitHub release HTML into readable lines', () => {
        expect(releaseNotesText(GITHUB_BODY)).toBe(
            [
                "What's Changed",
                '• fix(k8s): tell an unreachable cluster from a slow one by @araratpoghosyan in #101',
                '• perf(k8s): stop listing every pod to draw list screens by @araratpoghosyan in #102',
                'Full Changelog: v0.4.0...v0.4.1',
            ].join('\n'),
        );
    });

    it('leaves plain text alone', () => {
        expect(releaseNotesText('Fixes the namespace selector.')).toBe('Fixes the namespace selector.');
        expect(releaseNotesText('  Fixes the namespace selector.  ')).toBe('Fixes the namespace selector.');
    });

    it('decodes the entities GitHub escapes', () => {
        expect(
            releaseNotesText('<p>a &lt; b &amp;&amp; c &gt; d &quot;q&quot; &#39;s&#39;&nbsp;e &#x2014; f</p>'),
        ).toBe('a < b && c > d "q" \'s\' e — f');
    });

    it('leaves an entity it does not know as written', () => {
        expect(releaseNotesText('a &hellip; b &bogus; c')).toBe('a &hellip; b &bogus; c');
    });

    it('keeps paragraph breaks and drops blank runs', () => {
        expect(releaseNotesText('<p>One</p>\n\n\n<p>Two<br>Three</p><h3>Four</h3>text')).toBe(
            'One\nTwo\nThree\nFour\ntext',
        );
    });

    it('collapses whitespace inside a line', () => {
        expect(releaseNotesText('<li>a\n   <code>b</code>   c</li>')).toBe('• a b c');
    });

    it('answers empty for empty or tag-only input', () => {
        expect(releaseNotesText('')).toBe('');
        expect(releaseNotesText('   ')).toBe('');
        expect(releaseNotesText('<ul></ul><p></p>')).toBe('');
    });

    it('leaves an unfinished tag as text rather than swallowing the rest', () => {
        expect(releaseNotesText('fixed a < b comparison')).toBe('fixed a < b comparison');
    });
});
