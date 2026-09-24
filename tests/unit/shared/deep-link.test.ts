import { describe, expect, it } from 'vitest';
import {
    deepLinkInArgv,
    deepLinkSchema,
    formatDeepLink,
    normalizeServer,
    parseDeepLink,
} from '../../../src/shared/deep-link';

const EKS = 'https://abc123.gr7.eu-west-1.eks.amazonaws.com';
const at = (server: string, path = '') => `kubermeister://open/${encodeURIComponent(server)}${path}`;

describe('normalizeServer', () => {
    it('reads two spellings of one address as the same server', () => {
        expect(normalizeServer('HTTPS://ABC123.gr7.EU-WEST-1.eks.amazonaws.com:443/')).toBe(EKS);
        expect(normalizeServer(EKS)).toBe(EKS);
    });

    it('keeps a port that is not the default, and a path, which proxies such as Rancher route on', () => {
        expect(normalizeServer('https://127.0.0.1:6443')).toBe('https://127.0.0.1:6443');
        expect(normalizeServer('https://rancher.example.com/k8s/clusters/c-m-1/')).toBe(
            'https://rancher.example.com/k8s/clusters/c-m-1',
        );
    });

    it('answers nothing for an address that is not an http or https URL', () => {
        expect(normalizeServer('Development')).toBeUndefined();
        expect(normalizeServer('file:///etc/passwd')).toBeUndefined();
        expect(normalizeServer('')).toBeUndefined();
    });
});

describe('parseDeepLink', () => {
    it('reads the API server and the route path', () => {
        expect(parseDeepLink(at(EKS, '/workloads/pods/default/web-1/logs'))).toEqual({
            ok: true,
            server: EKS,
            path: '/workloads/pods/default/web-1/logs',
        });
    });

    it('reads the server in its normal form, whoever spelled it', () => {
        expect(parseDeepLink(at('HTTPS://ABC123.gr7.eu-west-1.eks.amazonaws.com:443/', '/workloads/pods'))).toEqual({
            ok: true,
            server: EKS,
            path: '/workloads/pods',
        });
    });

    it('reads a cluster-scoped path, which has no namespace segment', () => {
        expect(parseDeepLink(at('https://10.0.0.1:6443', '/overview/nodes/worker-1/describe'))).toEqual({
            ok: true,
            server: 'https://10.0.0.1:6443',
            path: '/overview/nodes/worker-1/describe',
        });
    });

    it('reads a link naming only a server as the app’s home screen', () => {
        expect(parseDeepLink(at(EKS))).toEqual({ ok: true, server: EKS, path: '/' });
    });

    it('tolerates the trailing slash Windows adds and the scheme in capitals', () => {
        expect(parseDeepLink(`KUBERMEISTER://open/${encodeURIComponent(EKS)}/workloads/pods/`)).toEqual({
            ok: true,
            server: EKS,
            path: '/workloads/pods',
        });
    });

    it('leaves the tab in the path: whether it may open is the route’s question', () => {
        expect(parseDeepLink(at(EKS, '/workloads/pods/default/web-1/shell'))).toMatchObject({
            ok: true,
            path: '/workloads/pods/default/web-1/shell',
        });
    });

    it.each([
        ['another scheme', `https://open/${encodeURIComponent(EKS)}/workloads/pods`],
        ['another action', `kubermeister://exec/${encodeURIComponent(EKS)}/workloads/pods`],
        ['no server', 'kubermeister://open/'],
        ['an empty server', 'kubermeister://open//workloads/pods'],
        ['a context name where the server goes', 'kubermeister://open/Development/workloads/pods'],
        ['a server that is not http or https', `kubermeister://open/${encodeURIComponent('file:///etc')}/workloads`],
        ['a dot-dot segment', at(EKS, '/workloads/../settings')],
        ['an encoded dot-dot segment', at(EKS, '/workloads/%2e%2e/settings')],
        ['an encoded slash in the path', at(EKS, '/workloads%2Fpods')],
        ['an empty segment', at(EKS, '/workloads//pods')],
        ['a query', at(EKS, '/workloads/pods?namespace=kube-system')],
        ['a fragment', at(EKS, '/workloads/pods#x')],
        ['a broken escape', 'kubermeister://open/%E0%A4%A/workloads'],
        ['a control character in the server', `kubermeister://open/${encodeURIComponent('https://a\n.b')}/x`],
        ['a script in a segment', at(EKS, '/%3Cscript%3E')],
        ['a URL past any the app would make', at(EKS, `/${'a'.repeat(5000)}`)],
    ])('refuses %s with a reason', (_name, url) => {
        const link = parseDeepLink(url);
        expect(link.ok).toBe(false);
        expect(deepLinkSchema.parse(link)).toEqual(link);
    });
});

describe('formatDeepLink', () => {
    it('writes a link that reads back as the same server and path', () => {
        const url = formatDeepLink(EKS, '/workloads/pods/default/web-1/logs');
        expect(url).toBe(
            'kubermeister://open/https%3A%2F%2Fabc123.gr7.eu-west-1.eks.amazonaws.com/workloads/pods/default/web-1/logs',
        );
        expect(parseDeepLink(url)).toEqual({ ok: true, server: EKS, path: '/workloads/pods/default/web-1/logs' });
    });

    it('writes the server in its normal form', () => {
        expect(formatDeepLink('HTTPS://ABC123.gr7.eu-west-1.eks.amazonaws.com:443/', '/')).toBe(
            'kubermeister://open/https%3A%2F%2Fabc123.gr7.eu-west-1.eks.amazonaws.com',
        );
    });
});

describe('deepLinkInArgv', () => {
    it('finds the link among the arguments a launch carries', () => {
        expect(deepLinkInArgv(['/opt/Kubermeister/kubermeister', '--no-sandbox', at(EKS)])).toBe(at(EKS));
    });

    it('finds nothing in a plain launch', () => {
        expect(deepLinkInArgv(['C:\\Kubermeister\\Kubermeister.exe', '.'])).toBeUndefined();
    });
});
