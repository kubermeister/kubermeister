import { z } from 'zod';

/** The URL scheme the app registers with the OS. */
export const DEEP_LINK_SCHEME = 'kubermeister';

const PREFIX = `${DEEP_LINK_SCHEME}://open/`;

/**
 * Past these a link is not one the app made. The OS hands the app whatever string was clicked, so
 * nothing about its size is trusted.
 */
const MAX_URL_LENGTH = 4096;
const MAX_CONTEXT_LENGTH = 1024;

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
        context: z.string().min(1).max(MAX_CONTEXT_LENGTH),
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

/** The link that opens `path` (the app's own route path) under `context`. */
export function formatDeepLink(context: string, path: string): string {
    const route = path.replace(/^\/+/, '');
    return `${PREFIX}${encodeURIComponent(context)}${route ? `/${route}` : ''}`;
}

/**
 * Read a `kubermeister://open/<context>/<route path>` link into the context it names and the route
 * path to open. The string comes from the OS, so it is read by hand rather than through `URL`,
 * which would resolve `..` and `%2e%2e` segments into a different path than the one written, and
 * anything that is not exactly this shape is refused with a sentence saying why. A query or a
 * fragment is refused rather than dropped, since the app's links carry neither.
 */
export function parseDeepLink(url: string): DeepLink {
    if (url.length > MAX_URL_LENGTH) return refused('The link is too long to be one of Kubermeister’s.');
    if (!url.toLowerCase().startsWith(PREFIX)) return refused('That is not a Kubermeister link.');
    if (/[?#]/.test(url)) return refused('The link carries a query or a fragment, which Kubermeister links never do.');
    // Windows hands a link over with a trailing slash of its own.
    const [rawContext, ...rest] = url.slice(PREFIX.length).replace(/\/+$/, '').split('/');
    const context = rawContext ? decode(rawContext) : undefined;
    if (!context) return refused('The link names no context.');
    if (context.length > MAX_CONTEXT_LENGTH || /[\p{Cc}]/u.test(context)) {
        return refused('The context the link names is not one a kubeconfig could hold.');
    }
    const segments: string[] = [];
    for (const raw of rest) {
        const segment = decode(raw);
        if (!segment || !SEGMENT.test(segment) || segment === '.' || segment === '..') {
            return refused('The link’s path is not one of Kubermeister’s screens.');
        }
        segments.push(encodeURIComponent(segment));
    }
    return { ok: true, context, path: `/${segments.join('/')}` };
}

/** The first argument that is a Kubermeister link: how Windows and Linux hand one to a launch. */
export function deepLinkInArgv(argv: readonly string[]): string | undefined {
    return argv.find((arg) => arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`));
}
