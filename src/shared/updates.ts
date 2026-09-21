/**
 * What the renderer needs to know about releases without asking the network: where a version's
 * release page lives. Every release is tagged `vX.Y.Z`, so the page follows from the version alone.
 */

export const REPOSITORY_URL = 'https://github.com/kubermeister/kubermeister';

/** The GitHub release page for a version: its `vX.Y.Z` tag. */
export function releasePageUrl(version: string): string {
    return `${REPOSITORY_URL}/releases/tag/v${version}`;
}

/**
 * The electron-updater feed the release workflow publishes beside the installers, one per platform.
 * An install that cannot replace itself reads this to learn a version exists, which is the part
 * that needs no package manager.
 */
export function releaseFeedUrl(platform: string): string {
    const file = platform === 'darwin' ? 'latest-mac.yml' : platform === 'win32' ? 'latest.yml' : 'latest-linux.yml';
    return `${REPOSITORY_URL}/releases/latest/download/${file}`;
}

/**
 * Orders two `X.Y.Z` versions, positive when the first is newer. Releases here carry no prerelease
 * or build parts — there is one channel and every tag is `vX.Y.Z` — so this needs no semver library,
 * and a part that will not parse counts as 0 rather than making the whole comparison meaningless.
 */
export function compareVersions(a: string, b: string): number {
    const parts = (version: string): number[] =>
        version
            .trim()
            .replace(/^v/, '')
            .split('.')
            .map((part) => {
                const parsed = Number.parseInt(part, 10);
                return Number.isNaN(parsed) ? 0 : parsed;
            });
    const left = parts(a);
    const right = parts(b);
    for (let i = 0; i < 3; i += 1) {
        const difference = (left[i] ?? 0) - (right[i] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}
