/** Only `http:`/`https:` URLs are safe to hand to the OS browser. */
export function isExternalWebUrl(url: string): boolean {
    try {
        const { protocol } = new URL(url);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

function withoutHash(url: string): string | null {
    try {
        const parsed = new URL(url);
        parsed.hash = '';
        return parsed.href;
    } catch {
        return null;
    }
}

/**
 * A navigation is internal only if it targets the app's own document: the Vite dev server in
 * development or the packaged `index.html` itself, with any hash route. Any other `file://` URL is
 * refused too, because a file dropped on a window nothing handles the drop in yet is a navigation to
 * that file, which would load it with the preload and the whole bridge attached. Anything else is
 * denied so a compromised renderer cannot navigate the top frame to an origin that would inherit it.
 */
export function isInternalNavigation(url: string, devServerUrl: string | undefined, indexFileUrl: string): boolean {
    if (devServerUrl) return url.startsWith(devServerUrl);
    const target = withoutHash(url);
    return target !== null && target === withoutHash(indexFileUrl);
}
