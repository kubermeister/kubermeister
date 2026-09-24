import { z } from 'zod';

/** The URL scheme the app registers with the OS. */
export const DEEP_LINK_SCHEME = 'kubermeister';

const PREFIX = `${DEEP_LINK_SCHEME}://open/`;

/**
 * Past these a link is not one the app made. The OS hands the app whatever string was clicked, so
 * nothing about its size is trusted.
 */
const MAX_URL_LENGTH = 4096;
const MAX_SERVER_LENGTH = 1024;

/**
 * Tabs a link never opens, because opening one acts: the Shell tab execs into the pod the moment it
 * mounts, and a click on a link is not a decision to open a shell. Such a link opens the object's
 * first tab, and Copy link writes it that way.
 */
export const UNLINKABLE_TABS: ReadonlySet<string> = new Set(['shell']);

/** A route segment as the app's own paths spell them: Kubernetes names, API groups, tab ids. */
const SEGMENT = /^[A-Za-z0-9._~:@-]+$/;

export const deepLinkSchema = z.discriminatedUnion('ok', [
    z.object({
        ok: z.literal(true),
        /**
         * The cluster's API server, in `normalizeServer`'s form: the one name for a cluster that is
         * the same on every machine reaching it, where a context is whatever each kubeconfig calls it.
         */
        server: z.string().min(1).max(MAX_SERVER_LENGTH),
        /** The app's own route path, starting with `/`, each segment percent-encoded. */
        path: z.string().regex(/^\/(?:[^/?#]+(?:\/[^/?#]+)*)?$/),
    }),
    z.object({ ok: z.literal(false), reason: z.string() }),
]);

export type DeepLink = z.infer<typeof deepLinkSchema>;

function refused(reason: string): DeepLink {
    return { ok: false, reason };
}

function decode(segment: string): string | undefined {
    try {
        return decodeURIComponent(segment);
    } catch {
        return undefined;
    }
}

/**
 * One spelling for one API server, so the address in a link and the `server` of a kubeconfig's
 * cluster entry compare equal however either was written: scheme and host in lower case, the default
 * port and a trailing slash dropped. The path stays, since a proxy such as Rancher's routes each
 * cluster on one. Credentials a URL might carry are never part of it, so a link never carries them.
 * Anything that is not an http or https URL is no server at all.
 */
export function normalizeServer(server: string): string | undefined {
    let url: URL;
    try {
        url = new URL(server);
    } catch {
        return undefined;
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.host) return undefined;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** The link that opens `path` (the app's own route path) on the cluster whose API server is `server`. */
export function formatDeepLink(server: string, path: string): string {
    const route = path.replace(/^\/+/, '');
    return `${PREFIX}${encodeURIComponent(normalizeServer(server) ?? server)}${route ? `/${route}` : ''}`;
}

/**
 * Read a `kubermeister://open/<API server>/<route path>` link into the cluster it names and the
 * route path to open. The string comes from the OS, so it is read by hand rather than through `URL`,
 * which would resolve `..` and `%2e%2e` segments into a different path than the one written, and
 * anything that is not exactly this shape is refused with a sentence saying why. A query or a
 * fragment is refused rather than dropped, since the app's links carry neither.
 */
export function parseDeepLink(url: string): DeepLink {
    if (url.length > MAX_URL_LENGTH) return refused('The link is too long to be one of Kubermeister’s.');
    if (!url.toLowerCase().startsWith(PREFIX)) return refused('That is not a Kubermeister link.');
    if (/[?#]/.test(url)) return refused('The link carries a query or a fragment, which Kubermeister links never do.');
    // Windows hands a link over with a trailing slash of its own.
    const [rawServer, ...rest] = url.slice(PREFIX.length).replace(/\/+$/, '').split('/');
    const written = rawServer ? decode(rawServer) : undefined;
    if (!written) return refused('The link names no cluster.');
    // `URL` would quietly drop a control character that a kubeconfig's server could never hold.
    const server = /[\p{Cc}]/u.test(written) ? undefined : normalizeServer(written);
    if (!server || server.length > MAX_SERVER_LENGTH) {
        return refused('The link does not name a cluster by its API server address.');
    }
    const segments: string[] = [];
    for (const raw of rest) {
        const segment = decode(raw);
        if (!segment || !SEGMENT.test(segment) || segment === '.' || segment === '..') {
            return refused('The link’s path is not one of Kubermeister’s screens.');
        }
        segments.push(encodeURIComponent(segment));
    }
    return { ok: true, server, path: `/${segments.join('/')}` };
}

/** The first argument that is a Kubermeister link: how Windows and Linux hand one to a launch. */
export function deepLinkInArgv(argv: readonly string[]): string | undefined {
    return argv.find((arg) => arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`));
}
