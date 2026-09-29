import type { V1Endpoints, V1Ingress, V1NetworkPolicy, V1Service } from '@kubernetes/client-node';
import type {
    Endpoints,
    EndpointsDetail,
    Ingress,
    IngressDetail,
    IngressRule,
    NetworkPolicy,
    NetworkPolicyDetail,
    NetworkStatus,
    Service,
    ServiceDetail,
    ServiceEndpoint,
    ServicePort,
} from '../../../shared/k8s/network.js';
import { apis, getNamespaced, listItems } from '../client.js';
import { withK8s } from '../errors.js';
import { age, dash, formatLabelSelector, toPairs } from '../format.js';

/*
 * Pure transforms first, exported for tests and for the watch stream; thin readers at the end.
 */

/** Load balancer ingress addresses, then explicit external IPs, else an em-dash. */
export function serviceExternalIp(service: V1Service): string {
    const ingress = service.status?.loadBalancer?.ingress ?? [];
    const external = ingress.map((entry) => entry.ip ?? entry.hostname).filter(Boolean) as string[];
    if (external.length > 0) return external.join(', ');
    if (service.spec?.externalIPs?.length) return service.spec.externalIPs.join(', ');
    return '—';
}

export function servicePortsSummary(service: V1Service): string {
    const ports = service.spec?.ports ?? [];
    if (ports.length === 0) return '—';
    return ports.map((port) => `${port.port}/${port.protocol ?? 'TCP'}`).join(',');
}

/** A load balancer still waiting for an address is Pending; anything else is already serving. */
export function serviceStatus(service: V1Service): NetworkStatus {
    return service.spec?.type === 'LoadBalancer' && serviceExternalIp(service) === '—' ? 'Pending' : 'Active';
}

export function toService(service: V1Service, now = Date.now()): Service {
    return {
        name: service.metadata?.name ?? '',
        namespace: service.metadata?.namespace ?? '',
        type: service.spec?.type ?? 'ClusterIP',
        status: serviceStatus(service),
        clusterIp: service.spec?.clusterIP ?? 'None',
        externalIp: serviceExternalIp(service),
        ports: servicePortsSummary(service),
        age: age(service.metadata?.creationTimestamp, now),
    };
}

export function toServiceDetail(service: V1Service, now = Date.now()): ServiceDetail {
    return {
        ...toService(service, now),
        selector: Object.entries(service.spec?.selector ?? {}),
        labels: toPairs(service.metadata?.labels),
        annotations: toPairs(service.metadata?.annotations),
    };
}

export function toServicePorts(service: V1Service): ServicePort[] {
    return (service.spec?.ports ?? []).map((port) => ({
        name: dash(port.name),
        port: String(port.port),
        protocol: port.protocol ?? 'TCP',
        target: dash(port.targetPort != null ? String(port.targetPort) : undefined),
        appProtocol: dash(port.appProtocol),
    }));
}

export function toServiceEndpoints(endpoints: V1Endpoints): ServiceEndpoint[] {
    const rows: ServiceEndpoint[] = [];
    for (const subset of endpoints.subsets ?? []) {
        for (const address of subset.addresses ?? []) {
            rows.push({
                pod: dash(address.targetRef?.name),
                node: dash(address.nodeName),
                address: dash(address.ip),
                ready: 'Ready',
            });
        }
        for (const address of subset.notReadyAddresses ?? []) {
            rows.push({
                pod: dash(address.targetRef?.name),
                node: dash(address.nodeName),
                address: dash(address.ip),
                ready: 'NotReady',
            });
        }
    }
    return rows;
}

const CERT_MANAGER_ISSUERS = ['cert-manager.io/cluster-issuer', 'cert-manager.io/issuer'];

export function toIngress(ingress: V1Ingress, now = Date.now()): Ingress {
    const hosts = (ingress.spec?.rules ?? []).map((rule) => rule.host).filter(Boolean) as string[];
    const addresses = (ingress.status?.loadBalancer?.ingress ?? [])
        .map((entry) => entry.ip ?? entry.hostname)
        .filter(Boolean) as string[];
    return {
        name: ingress.metadata?.name ?? '',
        namespace: ingress.metadata?.namespace ?? '',
        className: dash(ingress.spec?.ingressClassName),
        status: addresses.length > 0 ? 'Active' : 'Pending',
        hosts: hosts.length ? hosts.join(', ') : '*',
        address: addresses.length ? addresses.join(', ') : '—',
        ports: ingress.spec?.tls?.length ? '80,443' : '80',
        age: age(ingress.metadata?.creationTimestamp, now),
    };
}

export function toIngressDetail(ingress: V1Ingress, now = Date.now()): IngressDetail {
    const annotations = ingress.metadata?.annotations ?? {};
    const issuer = CERT_MANAGER_ISSUERS.map((key) => annotations[key]).find(Boolean);
    return {
        ...toIngress(ingress, now),
        tls: (ingress.spec?.tls ?? []).map((tls) => ({
            secretName: dash(tls.secretName),
            hosts: (tls.hosts ?? []).join(', ') || '*',
        })),
        ...(issuer ? { issuer } : {}),
        labels: toPairs(ingress.metadata?.labels),
        annotations: toPairs(annotations),
    };
}

export function toIngressRules(ingress: V1Ingress): IngressRule[] {
    const rules: IngressRule[] = [];
    for (const rule of ingress.spec?.rules ?? []) {
        for (const path of rule.http?.paths ?? []) {
            const port = path.backend?.service?.port;
            rules.push({
                host: dash(rule.host),
                path: dash(path.path),
                backend: dash(path.backend?.service?.name),
                port: dash(port?.number != null ? String(port.number) : port?.name),
            });
        }
    }
    return rules;
}

/** The first two addresses with their port, then a "+N more" tail so the cell stays one line. */
export function endpointsSummary(endpoints: V1Endpoints): string {
    const pairs: string[] = [];
    for (const subset of endpoints.subsets ?? []) {
        const port = subset.ports?.[0]?.port;
        for (const address of subset.addresses ?? []) {
            pairs.push(port != null ? `${address.ip}:${port}` : (address.ip ?? ''));
        }
    }
    if (pairs.length === 0) return '—';
    const shown = pairs.slice(0, 2).join(', ');
    return pairs.length > 2 ? `${shown}, +${pairs.length - 2} more` : shown;
}

export function toEndpoints(endpoints: V1Endpoints, now = Date.now()): Endpoints {
    return {
        name: endpoints.metadata?.name ?? '',
        namespace: endpoints.metadata?.namespace ?? '',
        endpoints: endpointsSummary(endpoints),
        age: age(endpoints.metadata?.creationTimestamp, now),
    };
}

export function toEndpointsDetail(endpoints: V1Endpoints, now = Date.now()): EndpointsDetail {
    return {
        ...toEndpoints(endpoints, now),
        labels: toPairs(endpoints.metadata?.labels),
        annotations: toPairs(endpoints.metadata?.annotations),
    };
}

export function toNetworkPolicy(policy: V1NetworkPolicy, now = Date.now()): NetworkPolicy {
    return {
        name: policy.metadata?.name ?? '',
        namespace: policy.metadata?.namespace ?? '',
        podSelector: formatLabelSelector(policy.spec?.podSelector ?? {}, {
            everything: '<all pods>',
            nothing: '<all pods>',
        }),
        policyTypes: (policy.spec?.policyTypes ?? []).join(', ') || '—',
        age: age(policy.metadata?.creationTimestamp, now),
    };
}

export function toNetworkPolicyDetail(policy: V1NetworkPolicy, now = Date.now()): NetworkPolicyDetail {
    return {
        ...toNetworkPolicy(policy, now),
        labels: toPairs(policy.metadata?.labels),
        annotations: toPairs(policy.metadata?.annotations),
    };
}

export function listServices(namespace?: string): Promise<Service[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().core.listNamespacedService({ namespace: ns }),
            () => apis().core.listServiceForAllNamespaces(),
        );
        return items.map((service) => toService(service));
    });
}

function readService(name: string, namespace?: string): Promise<V1Service | undefined> {
    return getNamespaced(name, namespace, (n, ns) => apis().core.readNamespacedService({ name: n, namespace: ns }));
}

export function getService(name: string, namespace?: string): Promise<ServiceDetail | null> {
    return withK8s('resources.get', async () => {
        const service = await readService(name, namespace);
        return service ? toServiceDetail(service) : null;
    });
}

export function getServicePorts(name: string, namespace: string): Promise<ServicePort[]> {
    return withK8s('services.ports', async () => {
        const service = await readService(name, namespace);
        return service ? toServicePorts(service) : [];
    });
}

/** The endpoints object shares the service's name, so the backing pods come from one read. */
export function getServiceEndpoints(name: string, namespace: string): Promise<ServiceEndpoint[]> {
    return withK8s('services.endpoints', async () => {
        const endpoints = await getNamespaced(name, namespace, (n, ns) =>
            apis().core.readNamespacedEndpoints({ name: n, namespace: ns }),
        );
        return endpoints ? toServiceEndpoints(endpoints) : [];
    });
}

export function listIngresses(namespace?: string): Promise<Ingress[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().net.listNamespacedIngress({ namespace: ns }),
            () => apis().net.listIngressForAllNamespaces(),
        );
        return items.map((ingress) => toIngress(ingress));
    });
}

function readIngress(name: string, namespace?: string): Promise<V1Ingress | undefined> {
    return getNamespaced(name, namespace, (n, ns) => apis().net.readNamespacedIngress({ name: n, namespace: ns }));
}

export function getIngress(name: string, namespace?: string): Promise<IngressDetail | null> {
    return withK8s('resources.get', async () => {
        const ingress = await readIngress(name, namespace);
        return ingress ? toIngressDetail(ingress) : null;
    });
}

export function getIngressRules(name: string, namespace: string): Promise<IngressRule[]> {
    return withK8s('ingresses.rules', async () => {
        const ingress = await readIngress(name, namespace);
        return ingress ? toIngressRules(ingress) : [];
    });
}

export function listEndpoints(namespace?: string): Promise<Endpoints[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().core.listNamespacedEndpoints({ namespace: ns }),
            () => apis().core.listEndpointsForAllNamespaces(),
        );
        return items.map((endpoints) => toEndpoints(endpoints));
    });
}

export function getEndpoints(name: string, namespace?: string): Promise<EndpointsDetail | null> {
    return withK8s('resources.get', async () => {
        const endpoints = await getNamespaced(name, namespace, (n, ns) =>
            apis().core.readNamespacedEndpoints({ name: n, namespace: ns }),
        );
        return endpoints ? toEndpointsDetail(endpoints) : null;
    });
}

export function listNetworkPolicies(namespace?: string): Promise<NetworkPolicy[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().net.listNamespacedNetworkPolicy({ namespace: ns }),
            () => apis().net.listNetworkPolicyForAllNamespaces(),
        );
        return items.map((policy) => toNetworkPolicy(policy));
    });
}

export function getNetworkPolicy(name: string, namespace?: string): Promise<NetworkPolicyDetail | null> {
    return withK8s('resources.get', async () => {
        const policy = await getNamespaced(name, namespace, (n, ns) =>
            apis().net.readNamespacedNetworkPolicy({ name: n, namespace: ns }),
        );
        return policy ? toNetworkPolicyDetail(policy) : null;
    });
}
