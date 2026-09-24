import { describe, expect, it } from 'vitest';
import { deepLinkInArgv, deepLinkSchema, formatDeepLink, parseDeepLink } from '../../../src/shared/deep-link';

describe('parseDeepLink', () => {
    it('reads the context and the route path', () => {
        expect(parseDeepLink('kubermeister://open/prod-eu/workloads/pods/default/web-1/logs')).toEqual({
            ok: true,
            context: 'prod-eu',
            path: '/workloads/pods/default/web-1/logs',
        });
    });

    it('decodes a context holding the colons and slashes of an EKS ARN', () => {
        const context = 'arn:aws:eks:eu-west-1:123:cluster/prod';
        const link = parseDeepLink(`kubermeister://open/${encodeURIComponent(context)}/workloads/pods/default/web-1`);
        expect(link).toEqual({ ok: true, context, path: '/workloads/pods/default/web-1' });
    });

    it('reads a cluster-scoped path, which has no namespace segment', () => {
        expect(parseDeepLink('kubermeister://open/kind-dev/overview/nodes/worker-1/describe')).toEqual({
            ok: true,
            context: 'kind-dev',
            path: '/overview/nodes/worker-1/describe',
        });
    });

    it('reads a link naming only a context as the app’s home screen', () => {
        expect(parseDeepLink('kubermeister://open/dev')).toEqual({ ok: true, context: 'dev', path: '/' });
    });

    it('tolerates the trailing slash Windows adds and the scheme in capitals', () => {
        expect(parseDeepLink('KUBERMEISTER://open/dev/workloads/pods/')).toEqual({
            ok: true,
            context: 'dev',
            path: '/workloads/pods',
        });
    });

    it('leaves the tab in the path: whether it may open is the route’s question', () => {
        expect(parseDeepLink('kubermeister://open/dev/workloads/pods/default/web-1/shell')).toMatchObject({
            ok: true,
            path: '/workloads/pods/default/web-1/shell',
        });
    });

    it.each([
        ['another scheme', 'https://open/dev/workloads/pods'],
        ['another action', 'kubermeister://exec/dev/workloads/pods'],
        ['no context', 'kubermeister://open/'],
        ['an empty context', 'kubermeister://open//workloads/pods'],
        ['a dot-dot segment', 'kubermeister://open/dev/workloads/../settings'],
        ['an encoded dot-dot segment', 'kubermeister://open/dev/workloads/%2e%2e/settings'],
        ['an encoded slash in the path', 'kubermeister://open/dev/workloads%2Fpods'],
        ['an empty segment', 'kubermeister://open/dev/workloads//pods'],
        ['a query', 'kubermeister://open/dev/workloads/pods?namespace=kube-system'],
        ['a fragment', 'kubermeister://open/dev/workloads/pods#x'],
        ['a broken escape', 'kubermeister://open/%E0%A4%A/workloads'],
        ['a control character in the context', 'kubermeister://open/dev%0A/workloads'],
        ['a script in a segment', 'kubermeister://open/dev/%3Cscript%3E'],
        ['a URL past any the app would make', `kubermeister://open/dev/${'a'.repeat(5000)}`],
    ])('refuses %s with a reason', (_name, url) => {
        const link = parseDeepLink(url);
        expect(link.ok).toBe(false);
        expect(deepLinkSchema.parse(link)).toEqual(link);
    });
});

describe('formatDeepLink', () => {
    it('writes a link that reads back as the same context and path', () => {
        const context = 'arn:aws:eks:eu-west-1:123:cluster/prod';
        const url = formatDeepLink(context, '/workloads/pods/default/web-1/logs');
        expect(url).toBe(
            'kubermeister://open/arn%3Aaws%3Aeks%3Aeu-west-1%3A123%3Acluster%2Fprod/workloads/pods/default/web-1/logs',
        );
        expect(parseDeepLink(url)).toEqual({ ok: true, context, path: '/workloads/pods/default/web-1/logs' });
    });

    it('writes the home screen as the context alone', () => {
        expect(formatDeepLink('dev', '/')).toBe('kubermeister://open/dev');
    });
});

describe('deepLinkInArgv', () => {
    it('finds the link among the arguments a launch carries', () => {
        expect(deepLinkInArgv(['/opt/Kubermeister/kubermeister', '--no-sandbox', 'kubermeister://open/dev'])).toBe(
            'kubermeister://open/dev',
        );
    });

    it('finds nothing in a plain launch', () => {
        expect(deepLinkInArgv(['C:\\Kubermeister\\Kubermeister.exe', '.'])).toBeUndefined();
    });
});
