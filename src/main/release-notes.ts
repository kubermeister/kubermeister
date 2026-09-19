/**
 * electron-updater reads a stable release's notes from GitHub's Atom feed, where the body arrives as
 * the HTML GitHub rendered for the releases page. The popover shows notes as text, so the markup is
 * flattened here, in main, before it crosses the bridge: headings and paragraphs become lines, list
 * items become bullets, every other tag is dropped and the entities GitHub escapes are decoded. Notes
 * that carry no markup pass through unchanged.
 */

const BLOCK_END = /<\/(?:p|div|h[1-6]|li|ul|ol|blockquote|pre|tr)\s*>|<br\s*\/?>|<hr\s*\/?>/gi;
const LIST_ITEM_START = /<li(?:\s[^<>]*)?>/gi;
const TAG = /<\/?[a-zA-Z][^<>]*>/g;
const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
};

function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
        if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(parseInt(body.slice(2), 16));
        if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
        return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    });
}

export function releaseNotesText(html: string): string {
    // Whitespace in the markup, line breaks included, is only ever a word gap; the tags say where lines end.
    const withBreaks = html
        .replace(/\s+/g, ' ')
        .replace(LIST_ITEM_START, '\n• ')
        .replace(BLOCK_END, '\n')
        .replace(TAG, '');
    return decodeEntities(withBreaks)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && line !== '•')
        .join('\n');
}
