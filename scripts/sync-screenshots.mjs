/**
 * Writes the committed screenshot set, `docs/screenshots/<theme>/<shot>.webp`, from the harness's
 * raw PNGs in `.screenshots/`.
 *
 *   npm run build && npm run screenshots    # shoot, into .screenshots/
 *   npm run screenshots:sync -- pod-logs    # commit the shots whose screen changed
 *   npm run screenshots:sync                # commit only shots that have no image yet
 *   npm run screenshots:sync -- --all       # replace the whole set
 *
 * Only named shots are written, because every run differs from the last in pixels nobody changed
 * — ages, timestamps, chart lines, generated pod names — and git keeps every version of a binary
 * for good. The pull request that changes a screen names that screen's shots, so one change
 * commits the images it affects and nothing else.
 *
 * The images are near-lossless WebP, a third the size of the PNGs with no artifacts on small text,
 * and at most 2048 px wide: the harness photographs a 1440x900 window at 2x, and no page serves one
 * above 1920 wide.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const RAW = resolve('.screenshots');
const COMMITTED = resolve('docs/screenshots');
const THEMES = ['dark', 'light'];
const MAX_WIDTH = 2048;

const args = process.argv.slice(2);
const all = args.includes('--all');
const named = args.filter((arg) => arg !== '--all');

const shotsIn = (dir, extension) =>
    existsSync(dir)
        ? readdirSync(dir)
              .filter((file) => file.endsWith(extension))
              .map((file) => file.slice(0, -extension.length))
        : [];

const raw = new Set(THEMES.flatMap((theme) => shotsIn(join(RAW, theme), '.png')));
if (raw.size === 0) {
    console.error(`No screenshots in ${RAW}.\nShoot them first:\n  npm run build && npm run screenshots`);
    process.exit(1);
}

const committed = new Set(THEMES.flatMap((theme) => shotsIn(join(COMMITTED, theme), '.webp')));
const shots = all ? [...raw] : named.length > 0 ? named : [...raw].filter((shot) => !committed.has(shot));

// A shot is committed in both themes or not at all, since a page shows whichever matches the
// reader's theme; a half-shot pair is caught here rather than on a published page.
const missing = shots.flatMap((shot) =>
    THEMES.filter((theme) => !existsSync(join(RAW, theme, `${shot}.png`))).map((theme) => `${theme}/${shot}.png`),
);
if (missing.length > 0) {
    console.error(`Not in ${RAW}:\n${missing.map((file) => `  - ${file}`).join('\n')}`);
    console.error('\nShoot them with `npm run screenshots`, or check the names against tests/demo/shots.');
    process.exit(1);
}

let bytesIn = 0;
let bytesOut = 0;
for (const shot of shots) {
    for (const theme of THEMES) {
        const from = join(RAW, theme, `${shot}.png`);
        const to = join(COMMITTED, theme);
        mkdirSync(to, { recursive: true });
        const { size } = await sharp(from)
            .resize({ width: MAX_WIDTH, withoutEnlargement: true })
            .webp({ nearLossless: true, quality: 60, effort: 6 })
            .toFile(join(to, `${shot}.webp`));
        bytesIn += statSync(from).size;
        bytesOut += size;
    }
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
if (shots.length === 0) {
    console.log('Every shot already has an image. Name the ones whose screen changed, or pass --all.');
} else {
    console.log(`Wrote ${shots.length} shot(s) in both themes: ${mb(bytesIn)} PNG -> ${mb(bytesOut)} WebP`);
    console.log(shots.map((shot) => `  - ${shot}`).join('\n'));
}

// The harness is the list of shots, so an image it no longer takes is one no page should be using.
const stale = [...committed].filter((shot) => !raw.has(shot));
if (all && stale.length > 0) {
    console.warn(
        `\nCommitted but no longer shot, so delete them if nothing uses them:\n${stale.map((s) => `  - ${s}`).join('\n')}`,
    );
}
