import { KubeConfig } from '@kubernetes/client-node';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/settings';

let settings: Settings;
vi.mock('../../../src/main/settings/store.js', () => ({ getSettings: () => settings }));

const { applyNetworkSettings, caBundleProblem, networkSummary, redactProxyUrl, resolveProxy } =
    await import('../../../src/main/k8s/proxy.js');

const CERT = '-----BEGIN CERTIFICATE-----\nMIIBcorporateRoot\n-----END CERTIFICATE-----\n';
const CLUSTER_CERT = '-----BEGIN CERTIFICATE-----\nMIIBclusterRoot\n-----END CERTIFICATE-----\n';

function network(patch: Partial<Settings['network']> = {}): Settings['network'] {
    return { ...DEFAULT_SETTINGS.network, ...patch };
}

function withSettings(patch: Partial<Settings['network']> = {}): void {
    settings = { ...DEFAULT_SETTINGS, network: network(patch) };
}

/** A config carrying one cluster, as the library hands it back after a load. */
function configWith(cluster: Partial<Parameters<KubeConfig['addCluster']>[0]> = {}): KubeConfig {
    const kc = new KubeConfig();
    kc.loadFromOptions({
        clusters: [{ name: 'c', server: 'https://api.corp.example:6443', skipTLSVerify: false, ...cluster }],
        users: [{ name: 'u' }],
        contexts: [{ name: 'ctx', cluster: 'c', user: 'u' }],
        currentContext: 'ctx',
    });
    return kc;
}

const decode = (caData: string | undefined): string => Buffer.from(caData ?? '', 'base64').toString('utf8');

let dir = '';
beforeEach(() => {
    withSettings();
    dir = mkdtempSync(join(tmpdir(), 'km-proxy-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveProxy', () => {
    it('follows the variable for the server scheme, never the other one', () => {
        const env = { HTTPS_PROXY: 'http://secure:3128', HTTP_PROXY: 'http://plain:3128' };
        expect(resolveProxy('https://api.corp.example:6443', network(), env)).toBe('http://secure:3128');
        expect(resolveProxy('http://api.corp.example:8080', network(), env)).toBe('http://plain:3128');
        // kubectl reads one variable per scheme, so an https server is never proxied by HTTP_PROXY.
        expect(resolveProxy('https://api.corp.example', network(), { HTTP_PROXY: 'http://plain:3128' })).toBeNull();
    });

    it('prefers the upper-case name and falls back to the lower-case one', () => {
        expect(resolveProxy('https://api.example', network(), { https_proxy: 'http://lower:3128' })).toBe(
            'http://lower:3128',
        );
        expect(
            resolveProxy('https://api.example', network(), {
                HTTPS_PROXY: 'http://upper:3128',
                https_proxy: 'http://lower:3128',
            }),
        ).toBe('http://upper:3128');
    });

    it('reads a bare host:port as an http proxy and ignores a value that is not one', () => {
        expect(resolveProxy('https://api.example', network(), { HTTPS_PROXY: 'proxy.corp:3128' })).toBe(
            'http://proxy.corp:3128',
        );
        expect(resolveProxy('https://api.example', network(), { HTTPS_PROXY: 'socks5://proxy.corp:1080' })).toBe(
            'socks5://proxy.corp:1080',
        );
        for (const bad of ['', '   ', 'http://', 'file:///etc/passwd', 'not a url']) {
            expect(resolveProxy('https://api.example', network(), { HTTPS_PROXY: bad })).toBeNull();
        }
    });

    it('never proxies loopback, whatever the environment says', () => {
        const env = { HTTPS_PROXY: 'http://proxy:3128', HTTP_PROXY: 'http://proxy:3128' };
        for (const server of ['https://localhost:6443', 'http://127.0.0.1:8080', 'https://[::1]:6443']) {
            expect(resolveProxy(server, network(), env)).toBeNull();
        }
    });

    it('honours NO_PROXY by exact host, by domain suffix and by wildcard', () => {
        const env = (noProxy: string) => ({ HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: noProxy });
        expect(resolveProxy('https://api.corp.example:6443', network(), env('api.corp.example'))).toBeNull();
        expect(resolveProxy('https://api.corp.example:6443', network(), env('.corp.example'))).toBeNull();
        expect(resolveProxy('https://api.corp.example:6443', network(), env('corp.example'))).toBeNull();
        expect(resolveProxy('https://api.corp.example:6443', network(), env('*'))).toBeNull();
        expect(resolveProxy('https://api.corp.example:6443', network(), env('other.example, api.corp'))).toBe(
            'http://proxy:3128',
        );
        // Entries may be separated by commas, spaces or both.
        expect(
            resolveProxy('https://api.corp.example:6443', network(), env('a.example , api.corp.example')),
        ).toBeNull();
    });

    it('honours a NO_PROXY entry that names a port, and only that port', () => {
        const env = (noProxy: string) => ({ HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: noProxy });
        expect(resolveProxy('https://api.corp.example:6443', network(), env('api.corp.example:6443'))).toBeNull();
        expect(resolveProxy('https://api.corp.example:6443', network(), env('api.corp.example:443'))).toBe(
            'http://proxy:3128',
        );
        // An https server with no port in the URL is on 443.
        expect(resolveProxy('https://api.corp.example', network(), env('api.corp.example:443'))).toBeNull();
    });

    it('honours an IPv4 CIDR entry, which is how a private API server is usually excluded', () => {
        const env = (noProxy: string) => ({ HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: noProxy });
        expect(resolveProxy('https://10.42.0.1:6443', network(), env('10.0.0.0/8'))).toBeNull();
        expect(resolveProxy('https://192.168.1.10:6443', network(), env('10.0.0.0/8'))).toBe('http://proxy:3128');
        expect(resolveProxy('https://10.42.0.1:6443', network(), env('10.42.0.1'))).toBeNull();
        expect(resolveProxy('https://11.0.0.1:6443', network(), env('0.0.0.0/0'))).toBeNull();
    });

    it('uses the proxy named in Settings, and none at all when it is not set', () => {
        const env = { HTTPS_PROXY: 'http://from-env:3128' };
        expect(
            resolveProxy('https://api.example', network({ proxyMode: 'manual', proxyUrl: 'http://chosen:8080' }), env),
        ).toBe('http://chosen:8080');
        expect(resolveProxy('https://api.example', network({ proxyMode: 'manual' }), env)).toBeNull();
    });

    it('connects directly when the user asked to, however the environment is set', () => {
        const env = { HTTPS_PROXY: 'http://from-env:3128' };
        expect(resolveProxy('https://api.example', network({ proxyMode: 'off' }), env)).toBeNull();
        expect(
            resolveProxy('https://api.example', network({ proxyMode: 'off', proxyUrl: 'http://chosen:8080' }), env),
        ).toBeNull();
    });

    it('lets the bypass list in Settings stand in for NO_PROXY, in either mode', () => {
        const env = { HTTPS_PROXY: 'http://from-env:3128', NO_PROXY: 'ignored.example' };
        expect(resolveProxy('https://api.corp.example', network({ noProxy: '.corp.example' }), env)).toBeNull();
        expect(resolveProxy('https://ignored.example', network({ noProxy: '.corp.example' }), env)).toBe(
            'http://from-env:3128',
        );
        expect(
            resolveProxy(
                'https://api.corp.example',
                network({ proxyMode: 'manual', proxyUrl: 'http://chosen:8080', noProxy: 'api.corp.example' }),
                env,
            ),
        ).toBeNull();
    });

    it('is null for a server that is not a URL at all', () => {
        expect(resolveProxy('', network(), { HTTPS_PROXY: 'http://proxy:3128' })).toBeNull();
        expect(resolveProxy('api.corp.example:6443', network(), { HTTPS_PROXY: 'http://proxy:3128' })).toBeNull();
    });
});

describe('applyNetworkSettings', () => {
    it('points every cluster at the proxy its own server resolves to', () => {
        const kc = new KubeConfig();
        kc.loadFromOptions({
            clusters: [
                { name: 'remote', server: 'https://api.corp.example:6443', skipTLSVerify: false },
                { name: 'local', server: 'https://127.0.0.1:6443', skipTLSVerify: false },
            ],
            users: [{ name: 'u' }],
            contexts: [{ name: 'ctx', cluster: 'remote', user: 'u' }],
            currentContext: 'ctx',
        });
        applyNetworkSettings(kc, { HTTPS_PROXY: 'http://proxy:3128' });
        expect(kc.getCluster('remote')?.proxyUrl).toBe('http://proxy:3128');
        expect(kc.getCluster('local')?.proxyUrl).toBeUndefined();
    });

    it('never overrides a proxy the kubeconfig itself sets for that cluster', () => {
        for (const mode of ['env', 'manual', 'off'] as const) {
            withSettings({ proxyMode: mode, proxyUrl: 'http://chosen:8080' });
            const kc = configWith({ proxyUrl: 'http://from-file:3128' });
            applyNetworkSettings(kc, { HTTPS_PROXY: 'http://from-env:3128' });
            expect(kc.getCluster('c')?.proxyUrl).toBe('http://from-file:3128');
        }
    });

    it('leaves the config untouched when nothing is configured', () => {
        const kc = configWith({ caData: Buffer.from(CLUSTER_CERT).toString('base64') });
        const before = kc.getCluster('c');
        applyNetworkSettings(kc, {});
        expect(kc.getCluster('c')).toEqual(before);
    });

    it('adds the CA bundle to the cluster CA rather than replacing it', () => {
        const path = join(dir, 'corp.pem');
        writeFileSync(path, CERT);
        withSettings({ caBundlePath: path });
        const kc = configWith({ caData: Buffer.from(CLUSTER_CERT).toString('base64') });
        applyNetworkSettings(kc, {});
        const ca = decode(kc.getCluster('c')?.caData);
        expect(ca).toContain(CLUSTER_CERT.trim());
        expect(ca).toContain(CERT.trim());
    });

    it('reads a cluster CA held in a file and folds the bundle in beside it', () => {
        const bundle = join(dir, 'corp.pem');
        const clusterCa = join(dir, 'cluster.pem');
        writeFileSync(bundle, CERT);
        writeFileSync(clusterCa, CLUSTER_CERT);
        withSettings({ caBundlePath: bundle });
        const kc = configWith({ caFile: clusterCa });
        applyNetworkSettings(kc, {});
        const cluster = kc.getCluster('c');
        // The file is folded into the data, so the library reads one CA covering both.
        expect(cluster?.caFile).toBeUndefined();
        expect(decode(cluster?.caData)).toContain(CLUSTER_CERT.trim());
        expect(decode(cluster?.caData)).toContain(CERT.trim());
    });

    it('keeps the public roots when the cluster brings no CA of its own', () => {
        const path = join(dir, 'corp.pem');
        writeFileSync(path, CERT);
        withSettings({ caBundlePath: path });
        const kc = configWith();
        applyNetworkSettings(kc, {});
        const ca = decode(kc.getCluster('c')?.caData);
        expect(ca).toContain(CERT.trim());
        // Trusting one extra authority must not stop a cluster with a public certificate working.
        expect(ca).toContain(rootCertificates[0]?.trim());
    });

    it('leaves a cluster alone when its bundle, or its own CA file, cannot be read', () => {
        withSettings({ caBundlePath: join(dir, 'missing.pem') });
        const kc = configWith({ caData: Buffer.from(CLUSTER_CERT).toString('base64') });
        applyNetworkSettings(kc, {});
        expect(decode(kc.getCluster('c')?.caData)).toBe(CLUSTER_CERT);

        const bundle = join(dir, 'corp.pem');
        writeFileSync(bundle, CERT);
        withSettings({ caBundlePath: bundle });
        const gone = configWith({ caFile: join(dir, 'gone.pem') });
        applyNetworkSettings(gone, {});
        expect(gone.getCluster('c')?.caFile).toBe(join(dir, 'gone.pem'));
        expect(gone.getCluster('c')?.caData).toBeUndefined();
    });

    it('folds in nothing from a file that holds no certificate', () => {
        const path = join(dir, 'notes.txt');
        writeFileSync(path, 'these are not certificates\n');
        withSettings({ caBundlePath: path });
        const kc = configWith({ caData: Buffer.from(CLUSTER_CERT).toString('base64') });
        applyNetworkSettings(kc, {});
        expect(decode(kc.getCluster('c')?.caData)).toBe(CLUSTER_CERT);
    });

    it('applies the proxy and the bundle together', () => {
        const path = join(dir, 'corp.pem');
        writeFileSync(path, CERT);
        withSettings({ proxyMode: 'manual', proxyUrl: 'http://chosen:8080', caBundlePath: path });
        const kc = configWith();
        applyNetworkSettings(kc, {});
        expect(kc.getCluster('c')?.proxyUrl).toBe('http://chosen:8080');
        expect(decode(kc.getCluster('c')?.caData)).toContain(CERT.trim());
    });
});

describe('caBundleProblem', () => {
    it('is null when no bundle is configured or the file holds certificates', () => {
        expect(caBundleProblem(null)).toBeNull();
        const path = join(dir, 'corp.pem');
        writeFileSync(path, `# corporate root\n${CERT}`);
        expect(caBundleProblem(path)).toBeNull();
    });

    it('names a file that is missing, unreadable or holds no certificate', () => {
        const missing = join(dir, 'missing.pem');
        expect(caBundleProblem(missing)).toContain(missing);

        const empty = join(dir, 'empty.pem');
        writeFileSync(empty, 'not a certificate\n');
        expect(caBundleProblem(empty)).toContain('PEM');

        const locked = join(dir, 'locked.pem');
        writeFileSync(locked, CERT);
        chmodSync(locked, 0o000);
        // Running as root defeats the permission bits, so only assert when they bite.
        try {
            expect(caBundleProblem(locked)).toContain(locked);
        } finally {
            chmodSync(locked, 0o600);
        }
    });
});

describe('networkSummary', () => {
    it('says what is in force, without the proxy credentials', () => {
        expect(networkSummary(null)).toBe('Connecting directly');
        expect(networkSummary({ name: 'c', server: 'https://api', skipTLSVerify: false })).toBe('Connecting directly');
        expect(
            networkSummary({
                name: 'c',
                server: 'https://api',
                skipTLSVerify: false,
                proxyUrl: 'http://user:secret@proxy:3128',
            }),
        ).toBe('Proxying through http://proxy:3128');
    });

    it('names the CA bundle in force', () => {
        withSettings({ caBundlePath: '/etc/corp/ca.pem' });
        expect(networkSummary(null)).toBe('Connecting directly, trusting extra certificates from /etc/corp/ca.pem');
    });
});

describe('redactProxyUrl', () => {
    it('drops any credentials the URL carries and leaves the rest alone', () => {
        expect(redactProxyUrl('http://user:secret@proxy:3128')).toBe('http://proxy:3128');
        expect(redactProxyUrl('http://proxy:3128')).toBe('http://proxy:3128');
        expect(redactProxyUrl('socks5://proxy:1080')).toBe('socks5://proxy:1080');
        // Anything unparseable is reported as configured rather than guessed at.
        expect(redactProxyUrl('nonsense')).toBe('nonsense');
    });
});
