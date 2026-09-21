import type { Cluster, KubeConfig } from '@kubernetes/client-node';
import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import { isProxyUrl, type NetworkSettings } from '../../shared/settings.js';
import { getSettings } from '../settings/store.js';

/**
 * How cluster traffic leaves this machine: the proxy it goes through and the certificate
 * authorities it trusts. Neither can be left to the launch environment. The client library reads no
 * proxy variable of its own — it proxies a cluster only when that cluster's kubeconfig entry carries
 * `proxy-url` — and a window opened from the Finder or the Dock inherits launchd's environment, which
 * has none of the variables the user's shell sets. So the app resolves both itself and writes the
 * answer onto the in-memory `KubeConfig`, where every path already reads it: `fetch` through the
 * undici dispatcher the library builds per cluster, and the exec and port-forward websockets through
 * its agent. The file on disk is never touched, the same as for a context switch.
 */

/** The variable each server scheme takes its proxy from, the same one kubectl would read. */
const PROXY_ENV_BY_SCHEME = { 'https:': 'HTTPS_PROXY', 'http:': 'HTTP_PROXY' } as const;

/** The value of an environment variable by its usual name, falling back to the lower-case spelling. */
function fromEnv(env: NodeJS.ProcessEnv, name: string): string | null {
    const value = env[name] ?? env[name.toLowerCase()];
    return value && value.trim() ? value.trim() : null;
}

/**
 * A proxy address the connection could be made through, or null. A bare `host:port`, which is how
 * `HTTPS_PROXY` is often written, reads as an http proxy, the way curl and Go read it; anything that
 * is not a proxy URL at all is ignored rather than handed to the agent to throw on later.
 */
function normalizeProxyUrl(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    return isProxyUrl(candidate) ? candidate : null;
}

/** Strip the brackets an IPv6 host wears in a URL, and the case a hostname may be written in. */
function hostOf(url: URL): string {
    return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** The port a request would actually go to: the one in the URL, else the scheme's own. */
function portOf(url: URL): number {
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
}

/** Loopback is never proxied, so a kind, k3s or minikube cluster works behind a corporate proxy. */
function isLoopback(host: string): boolean {
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
}

function ipv4ToInt(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        value = value * 256 + octet;
    }
    return value;
}

/**
 * An IPv4 CIDR entry, which is how a private API server range is usually excluded
 * (`NO_PROXY=10.0.0.0/8`). IPv6 ranges are not matched: they are vanishingly rare in a kubeconfig
 * and a half-right answer here would send credentials to a proxy the user excluded.
 */
function matchesCidr(host: string, entry: string): boolean {
    const [network, bits] = entry.split('/');
    if (!network || !bits || !/^\d{1,2}$/.test(bits)) return false;
    const prefix = Number(bits);
    if (prefix > 32) return false;
    const address = ipv4ToInt(host);
    const base = ipv4ToInt(network);
    if (address === null || base === null) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (address & mask) >>> 0 === (base & mask) >>> 0;
}

/**
 * Whether a host is excluded by a `NO_PROXY`-shaped list: `*` for everything, an exact host, a
 * domain suffix with or without its leading dot, an IPv4 CIDR range, and any of those with a port
 * that must match too.
 */
export function bypassesProxy(host: string, port: number, noProxy: string): boolean {
    for (const raw of noProxy.split(/[\s,]+/)) {
        const entry = raw.trim().toLowerCase();
        if (!entry) continue;
        if (entry === '*') return true;
        if (entry.includes('/')) {
            if (matchesCidr(host, entry)) return true;
            continue;
        }
        const match = /^(.*):(\d+)$/.exec(entry);
        if (match?.[1] && match[2] && Number(match[2]) !== port) continue;
        const pattern = (match?.[1] ?? entry).replace(/^\[|\]$/g, '');
        const suffix = pattern.startsWith('.') ? pattern.slice(1) : pattern;
        if (host === suffix || host.endsWith(`.${suffix}`)) return true;
    }
    return false;
}

/**
 * The proxy a cluster's API server should be reached through, or null for a direct connection.
 * Under `env` the variable for the server's own scheme decides, with no cross-scheme fallback, so
 * the app proxies exactly what a kubectl run in the same shell would.
 */
export function resolveProxy(
    server: string,
    network: NetworkSettings,
    env: NodeJS.ProcessEnv = process.env,
): string | null {
    if (network.proxyMode === 'off') return null;
    let url: URL;
    try {
        url = new URL(server);
    } catch {
        return null;
    }
    const scheme = url.protocol === 'https:' ? 'https:' : url.protocol === 'http:' ? 'http:' : null;
    if (!scheme) return null;
    const host = hostOf(url);
    if (isLoopback(host)) return null;
    const noProxy = network.noProxy ?? fromEnv(env, 'NO_PROXY') ?? '';
    if (bypassesProxy(host, portOf(url), noProxy)) return null;
    const configured = network.proxyMode === 'manual' ? network.proxyUrl : fromEnv(env, PROXY_ENV_BY_SCHEME[scheme]);
    return configured ? normalizeProxyUrl(configured) : null;
}

/** The marker every PEM certificate carries; a bundle without one is the wrong file. */
const PEM_MARKER = '-----BEGIN CERTIFICATE-----';

/**
 * Why the configured CA bundle cannot be used, or null. A path that was right when it was chosen and
 * is not any more would otherwise surface as a plain TLS failure on every screen, so it is reported
 * as its own startup check instead. Whether each certificate is valid is the TLS stack's business;
 * this only catches the file being missing, unreadable, or not a certificate bundle at all.
 */
export function caBundleProblem(path: string | null): string | null {
    if (!path) return null;
    let contents: string;
    try {
        contents = readFileSync(path, 'utf8');
    } catch {
        return `The CA bundle at ${path} could not be read.`;
    }
    return contents.includes(PEM_MARKER) ? null : `${path} holds no PEM certificate.`;
}

/** Everything a cluster should trust: its own authority, or the public roots, plus the extra bundle. */
function combinedCa(cluster: Cluster, extra: string): string | null {
    let own: string | null = null;
    if (cluster.caFile) {
        try {
            own = readFileSync(cluster.caFile, 'utf8');
        } catch {
            // The cluster's own CA is unreadable: leave the entry exactly as the kubeconfig wrote it
            // and let the library report it, rather than silently connecting on a different trust set.
            return null;
        }
    } else if (cluster.caData) {
        own = Buffer.from(cluster.caData, 'base64').toString('utf8');
    }
    // With no authority of its own a cluster is verified against Node's roots; naming a bundle adds
    // to that trust, as NODE_EXTRA_CA_CERTS does, and must not quietly take the public ones away.
    return `${own ?? rootCertificates.join('\n')}\n${extra}`;
}

function withNetwork(
    cluster: Cluster,
    network: NetworkSettings,
    extraCa: string | null,
    env: NodeJS.ProcessEnv,
): Cluster {
    // A kubeconfig that names a proxy for this cluster has said something more specific than any
    // app-wide setting could, in every mode.
    const proxyUrl = cluster.proxyUrl ?? resolveProxy(cluster.server, network, env) ?? undefined;
    const ca = extraCa === null ? null : combinedCa(cluster, extraCa);
    if (proxyUrl === cluster.proxyUrl && ca === null) return cluster;
    if (ca === null) return { ...cluster, proxyUrl };
    // One value carries both authorities, so the library reads a single CA covering the cluster's
    // own and the bundle's; the file it came from has been folded in and must not win over it.
    return { ...cluster, proxyUrl, caFile: undefined, caData: Buffer.from(ca).toString('base64') };
}

/**
 * Write the proxy and the extra certificate authorities onto a freshly loaded config, per cluster,
 * so every call made through it goes the way the user asked. Runs once per load; a change to either
 * setting reloads the config rather than editing one already in use.
 */
export function applyNetworkSettings(kc: KubeConfig, env: NodeJS.ProcessEnv = process.env): void {
    const { network } = getSettings();
    const extraCa = readExtraCa(network.caBundlePath);
    kc.clusters = kc.clusters.map((cluster) => withNetwork(cluster, network, extraCa, env));
}

/**
 * The configured bundle's certificates, or null when there is none, it cannot be read, or it is not
 * a certificate file. A bundle that cannot be used changes nothing about what is trusted; the
 * startup check is where it is reported, so the connection is not also silently altered here.
 */
function readExtraCa(path: string | null): string | null {
    if (!path) return null;
    try {
        const contents = readFileSync(path, 'utf8');
        return contents.includes(PEM_MARKER) ? contents : null;
    } catch {
        return null;
    }
}

/** A proxy URL fit to show: whatever credentials it carries are not part of the answer. */
export function redactProxyUrl(value: string): string {
    try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
    } catch {
        return value;
    }
}

/** One sentence for the startup check: how this cluster is reached, and what else it trusts. */
export function networkSummary(cluster: Cluster | null): string {
    const { caBundlePath } = getSettings().network;
    const head = cluster?.proxyUrl ? `Proxying through ${redactProxyUrl(cluster.proxyUrl)}` : 'Connecting directly';
    return caBundlePath ? `${head}, trusting extra certificates from ${caBundlePath}` : head;
}
