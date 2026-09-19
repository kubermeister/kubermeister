/**
 * What the renderer needs to know about releases without asking the network: where a version's
 * release page lives. Every release is tagged `vX.Y.Z`, so the page follows from the version alone.
 */

export const REPOSITORY_URL = 'https://github.com/kubermeister/kubermeister';

/** The GitHub release page for a version: its `vX.Y.Z` tag. */
export function releasePageUrl(version: string): string {
    return `${REPOSITORY_URL}/releases/tag/v${version}`;
}
