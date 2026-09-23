import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The website builds `/docs/` from this directory at each release tag, and nothing there can fix a
 * page after the tag is cut, so what would break a published page is caught here instead: a figure
 * with no image, or a link to a page or heading that does not exist.
 */

const DOCS = 'docs';
const THEMES = ['dark', 'light'];

function pagesIn(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'screenshots' ? [] : pagesIn(path);
        return /\.mdx?$/.test(entry.name) ? [path] : [];
    });
}

const pages = pagesIn(DOCS).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

/** The route the website gives a page: the prefix, the path without its extension, a slash. */
function routeOf(path: string): string {
    const slug = relative(DOCS, path)
        .replace(/\.mdx?$/, '')
        .replace(/(^|\/)index$/, '');
    return slug ? `/docs/${slug}/` : '/docs/';
}

/** GitHub-style heading ids, which is what Starlight generates. */
function slugify(heading: string): string {
    return heading
        .replace(/`/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, '')
        .replace(/ /g, '-');
}

const anchors = new Map(
    pages.map(({ path, text }) => [
        routeOf(path),
        new Set([...text.matchAll(/^#{2,6} (.+)$/gm)].map((match) => slugify(match[1]!.trim()))),
    ]),
);

describe('docs', () => {
    it('has pages to publish', () => {
        expect(pages.length).toBeGreaterThan(0);
    });

    it('commits both themes of every screenshot a page shows', () => {
        for (const { path, text } of pages) {
            for (const [, name] of text.matchAll(/<Figure[^>]*\bname="([^"]+)"/g)) {
                for (const theme of THEMES) {
                    expect(
                        existsSync(join(DOCS, 'screenshots', theme, `${name}.webp`)),
                        `${path}: ${theme}/${name}`,
                    ).toBe(true);
                }
            }
        }
    });

    it('links only to pages and headings that exist', () => {
        for (const { path, text } of pages) {
            const links = [...text.matchAll(/\]\((\/docs\/[^)\s]*)\)|href="(\/docs\/[^"]*)"/g)].map(
                (m) => m[1] ?? m[2]!,
            );
            for (const link of links) {
                const [route, anchor] = link.split('#') as [string, string | undefined];
                expect(route.endsWith('/'), `${path}: ${link} needs its trailing slash`).toBe(true);
                expect(anchors.has(route), `${path}: ${link} names no page`).toBe(true);
                if (anchor) expect(anchors.get(route)?.has(anchor), `${path}: ${link} names no heading`).toBe(true);
            }
        }
    });
});
