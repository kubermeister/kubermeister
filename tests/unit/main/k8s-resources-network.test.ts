import {
    ApiException,
    type V1Endpoints,
    type V1Ingress,
    type V1NetworkPolicy,
    type V1Service,
} from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = {
    listNamespacedService: vi.fn(),
    listServiceForAllNamespaces: vi.fn(),
    readNamespacedService: vi.fn(),
    listNamespacedEndpoints: vi.fn(),
    listEndpointsForAllNamespaces: vi.fn(),
    readNamespacedEndpoints: vi.fn(),
};
const net = {
    listNamespacedIngress: vi.fn(),
    listIngressForAllNamespaces: vi.fn(),
    readNamespacedIngress: vi.fn(),
    listNamespacedNetworkPolicy: vi.fn(),
    listNetworkPolicyForAllNamespaces: vi.fn(),
    readNamespacedNetworkPolicy: vi.fn(),
};
const client = {
    apis: () => ({ core, net }),
    getActiveNamespace: vi.fn<() => string | null>(),
    resolveObjectNamespace: (explicit?: string) => explicit ?? client.getActiveNamespace(),
    isSafeSelectorValue: () => true,
    listItems: async <T>(
        ns: string | undefined,
        namespaced: (ns: string) => Promise<{ items: T[] }>,
        all: () => Promise<{ items: T[] }>,
    ) => {
        const resolved = ns ?? client.getActiveNamespace() ?? undefined;
        return resolved ? namespaced(resolved) : all();
    },
    readOrNull: async <T>(read: () => Promise<T>) => {
        try {
            return await read();
        } catch (error) {
            if (error instanceof ApiException && error.code === 404) return undefined;
            throw error;
        }
    },
    getNamespaced: async <T>(
        name: string,
        namespace: string | undefined,
        readOne: (name: string, ns: string) => Promise<T>,
    ) => {
        const ns = client.resolveObjectNamespace(namespace);
        if (!ns) return undefined;
        return client.readOrNull(() => readOne(name, ns));
    },
};
vi.mock('../../../src/main/k8s/client.js', () => client);

const network = await import('../../../src/main/k8s/resources/network.js');

const NOW = Date.parse('2026-09-15T12:00:00Z');
const HOUR = 3600 * 1000;

const service = (overrides: Partial<V1Service> = {}): V1Service =>
    ({
        metadata: { name: 'web', namespace: 'team-a', creationTimestamp: new Date(NOW - HOUR), labels: { app: 'web' } },
        spec: {
            type: 'ClusterIP',
            clusterIP: '10.43.0.10',
            selector: { app: 'web' },
            ports: [{ name: 'http', port: 80, protocol: 'TCP', targetPort: 8080, appProtocol: 'http' }],
        },
        ...overrides,
    }) as V1Service;

describe('service transforms', () => {
    it('summarises ports, external address and status', () => {
        expect(network.servicePortsSummary(service())).toBe('80/TCP');
        expect(network.servicePortsSummary({ spec: {} })).toBe('—');
        expect(network.serviceExternalIp(service())).toBe('—');
        expect(network.serviceExternalIp(service({ status: { loadBalancer: { ingress: [{ ip: '1.2.3.4' }] } } }))).toBe(
            '1.2.3.4',
        );
        expect(network.serviceExternalIp(service({ spec: { externalIPs: ['9.9.9.9'] } }))).toBe('9.9.9.9');
        expect(network.serviceStatus(service())).toBe('Active');
        expect(network.serviceStatus(service({ spec: { type: 'LoadBalancer' } }))).toBe('Pending');
        expect(
            network.serviceStatus(
                service({
                    spec: { type: 'LoadBalancer' },
                    status: { loadBalancer: { ingress: [{ hostname: 'lb' }] } },
                }),
            ),
        ).toBe('Active');
    });

    it('builds the row, the selector pairs and the port table', () => {
        expect(network.toService(service(), NOW)).toEqual({
            name: 'web',
            namespace: 'team-a',
            type: 'ClusterIP',
            status: 'Active',
            clusterIp: '10.43.0.10',
            externalIp: '—',
            ports: '80/TCP',
            age: '1h',
        });
        expect(network.toServiceDetail(service(), NOW)).toMatchObject({
            selector: [['app', 'web']],
            labels: [['app', 'web']],
        });
        expect(network.toService({ metadata: { name: 'headless' }, spec: {} }, NOW)).toMatchObject({
            type: 'ClusterIP',
            clusterIp: 'None',
        });
        expect(network.toServicePorts(service())).toEqual([
            { name: 'http', port: '80', protocol: 'TCP', target: '8080', appProtocol: 'http' },
        ]);
        expect(network.toServicePorts({ spec: { ports: [{ port: 443 }] } })).toEqual([
            { name: '—', port: '443', protocol: 'TCP', target: '—', appProtocol: '—' },
        ]);
    });

    it('splits endpoint addresses into ready and not-ready rows', () => {
        const endpoints = {
            subsets: [
                {
                    addresses: [{ ip: '10.0.0.1', nodeName: 'n1', targetRef: { name: 'web-1' } }],
                    notReadyAddresses: [{ ip: '10.0.0.2' }],
                    ports: [{ port: 8080 }],
                },
            ],
        } as V1Endpoints;
        expect(network.toServiceEndpoints(endpoints)).toEqual([
            { pod: 'web-1', node: 'n1', address: '10.0.0.1', ready: 'Ready' },
            { pod: '—', node: '—', address: '10.0.0.2', ready: 'NotReady' },
        ]);
        expect(network.toServiceEndpoints({})).toEqual([]);
    });
});

const ingress = (overrides: Partial<V1Ingress> = {}): V1Ingress =>
    ({
        metadata: {
            name: 'web',
            namespace: 'team-a',
            creationTimestamp: new Date(NOW - HOUR),
            annotations: { 'cert-manager.io/cluster-issuer': 'letsencrypt' },
        },
        spec: {
            ingressClassName: 'traefik',
            tls: [{ secretName: 'web-tls', hosts: ['web.example.com'] }],
            rules: [
                {
                    host: 'web.example.com',
                    http: { paths: [{ path: '/', backend: { service: { name: 'web', port: { number: 80 } } } }] },
                },
            ],
        },
        status: { loadBalancer: { ingress: [{ ip: '1.2.3.4' }] } },
        ...overrides,
    }) as V1Ingress;

describe('ingress transforms', () => {
    it('joins hosts and addresses and opens 443 only with TLS', () => {
        expect(network.toIngress(ingress(), NOW)).toEqual({
            name: 'web',
            namespace: 'team-a',
            className: 'traefik',
            status: 'Active',
            hosts: 'web.example.com',
            address: '1.2.3.4',
            ports: '80,443',
            age: '1h',
        });
        const bare = network.toIngress({ metadata: { name: 'x' }, spec: { rules: [{}] } }, NOW);
        expect(bare).toMatchObject({ className: '—', hosts: '*', address: '—', ports: '80', status: 'Pending' });
    });

    it('carries TLS blocks and the cert-manager issuer on the detail', () => {
        const detail = network.toIngressDetail(ingress(), NOW);
        expect(detail.tls).toEqual([{ secretName: 'web-tls', hosts: 'web.example.com' }]);
        expect(detail.issuer).toBe('letsencrypt');
        const plain = network.toIngressDetail({ metadata: { name: 'x' } }, NOW);
        expect(plain.tls).toEqual([]);
        expect('issuer' in plain).toBe(false);
    });

    it('flattens rules to host, path, backend and port', () => {
        expect(network.toIngressRules(ingress())).toEqual([
            { host: 'web.example.com', path: '/', backend: 'web', port: '80' },
        ]);
        const named = network.toIngressRules({
            spec: { rules: [{ http: { paths: [{ backend: { service: { name: 'api', port: { name: 'http' } } } }] } }] },
        });
        expect(named).toEqual([{ host: '—', path: '—', backend: 'api', port: 'http' }]);
        expect(network.toIngressRules({})).toEqual([]);
    });
});

describe('endpoints and network policy transforms', () => {
    it('summarises the first addresses and counts the rest', () => {
        const many = {
            metadata: { name: 'web', namespace: 'team-a', creationTimestamp: new Date(NOW - HOUR) },
            subsets: [
                { ports: [{ port: 80 }], addresses: [{ ip: '10.0.0.1' }, { ip: '10.0.0.2' }, { ip: '10.0.0.3' }] },
            ],
        } as V1Endpoints;
        expect(network.endpointsSummary(many)).toBe('10.0.0.1:80, 10.0.0.2:80, +1 more');
        expect(network.endpointsSummary({ subsets: [{ addresses: [{ ip: '10.0.0.9' }] }] })).toBe('10.0.0.9');
        expect(network.endpointsSummary({})).toBe('—');
        expect(network.toEndpoints(many, NOW)).toMatchObject({ name: 'web', age: '1h' });
        expect(network.toEndpointsDetail(many, NOW)).toMatchObject({ labels: [], annotations: [] });
    });

    it('names the pod selector and policy types', () => {
        const policy = {
            metadata: { name: 'deny-all', namespace: 'team-a', creationTimestamp: new Date(NOW - HOUR) },
            spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] },
        } as V1NetworkPolicy;
        expect(network.toNetworkPolicy(policy, NOW)).toEqual({
            name: 'deny-all',
            namespace: 'team-a',
            podSelector: '<all pods>',
            policyTypes: 'Ingress, Egress',
            age: '1h',
        });
        expect(
            network.toNetworkPolicy({ metadata: {}, spec: { podSelector: { matchLabels: { app: 'web' } } } }, NOW),
        ).toMatchObject({ podSelector: 'app=web', policyTypes: '—' });
        // A policy selecting through expressions alone names them rather than claiming every pod.
        expect(
            network.toNetworkPolicy(
                {
                    metadata: {},
                    spec: {
                        podSelector: {
                            matchLabels: { app: 'web' },
                            matchExpressions: [{ key: 'tier', operator: 'NotIn', values: ['front', 'back'] }],
                        },
                    },
                },
                NOW,
            ).podSelector,
        ).toBe('app=web,tier notin (front,back)');
        expect(
            network.toNetworkPolicy(
                { metadata: {}, spec: { podSelector: { matchExpressions: [{ key: 'tier', operator: 'Exists' }] } } },
                NOW,
            ).podSelector,
        ).toBe('tier');
        expect(network.toNetworkPolicy({ metadata: {}, spec: {} }, NOW).podSelector).toBe('<all pods>');
        expect(network.toNetworkPolicyDetail(policy, NOW)).toMatchObject({ labels: [] });
    });
});

describe('network readers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        client.getActiveNamespace.mockReturnValue('team-a');
        core.listNamespacedService.mockResolvedValue({ items: [service()] });
        core.listServiceForAllNamespaces.mockResolvedValue({ items: [] });
        core.readNamespacedService.mockResolvedValue(service());
        core.readNamespacedEndpoints.mockResolvedValue({ subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] });
        core.listNamespacedEndpoints.mockResolvedValue({ items: [] });
        core.listEndpointsForAllNamespaces.mockResolvedValue({ items: [] });
        net.listNamespacedIngress.mockResolvedValue({ items: [ingress()] });
        net.listIngressForAllNamespaces.mockResolvedValue({ items: [] });
        net.readNamespacedIngress.mockResolvedValue(ingress());
        net.listNamespacedNetworkPolicy.mockResolvedValue({ items: [] });
        net.listNetworkPolicyForAllNamespaces.mockResolvedValue({ items: [] });
        net.readNamespacedNetworkPolicy.mockRejectedValue(new ApiException(404, 'x', null, {}));
    });

    it('lists and gets services with their ports and backing endpoints', async () => {
        expect((await network.listServices('explicit')).map((s) => s.name)).toEqual(['web']);
        expect(core.listNamespacedService).toHaveBeenCalledWith({ namespace: 'explicit' });
        await expect(network.getService('web', 'team-a')).resolves.toMatchObject({ selector: [['app', 'web']] });
        await expect(network.getServicePorts('web', 'team-a')).resolves.toHaveLength(1);
        await expect(network.getServiceEndpoints('web', 'team-a')).resolves.toEqual([
            { pod: '—', node: '—', address: '10.0.0.1', ready: 'Ready' },
        ]);
    });

    it('lists and gets ingresses with their rules', async () => {
        expect((await network.listIngresses()).map((i) => i.className)).toEqual(['traefik']);
        await expect(network.getIngress('web', 'team-a')).resolves.toMatchObject({ issuer: 'letsencrypt' });
        await expect(network.getIngressRules('web', 'team-a')).resolves.toHaveLength(1);
    });

    it('lists endpoints and policies and reports a missing object as null', async () => {
        await expect(network.listEndpoints()).resolves.toEqual([]);
        await expect(network.listNetworkPolicies()).resolves.toEqual([]);
        await expect(network.getNetworkPolicy('gone', 'team-a')).resolves.toBeNull();
        core.readNamespacedEndpoints.mockResolvedValue({
            metadata: { name: 'web', namespace: 'team-a' },
            subsets: [{ addresses: [{ ip: '10.0.0.1' }] }],
        });
        await expect(network.getEndpoints('web', 'team-a')).resolves.toMatchObject({
            name: 'web',
            endpoints: '10.0.0.1',
            labels: [],
        });
        client.getActiveNamespace.mockReturnValue(null);
        await network.listServices();
        expect(core.listServiceForAllNamespaces).toHaveBeenCalled();
    });

    it('returns empty ports and rules for objects that vanished, and classifies failures', async () => {
        core.readNamespacedService.mockRejectedValue(new ApiException(404, 'x', null, {}));
        net.readNamespacedIngress.mockRejectedValue(new ApiException(404, 'x', null, {}));
        await expect(network.getServicePorts('gone', 'team-a')).resolves.toEqual([]);
        await expect(network.getIngressRules('gone', 'team-a')).resolves.toEqual([]);
        core.readNamespacedEndpoints.mockRejectedValue(new ApiException(403, 'x', { message: 'denied' }, {}));
        await expect(network.getServiceEndpoints('web', 'team-a')).rejects.toMatchObject({
            kind: 'forbidden',
            op: 'services.endpoints',
        });
        net.listNamespacedIngress.mockRejectedValue(new ApiException(403, 'x', { message: 'denied' }, {}));
        await expect(network.listIngresses()).rejects.toMatchObject({ op: 'resources.list' });
    });
});
