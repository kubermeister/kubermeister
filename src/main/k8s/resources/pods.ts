import type { V1Container, V1ContainerStatus, V1Pod, V1Probe } from '@kubernetes/client-node';
import type {
    ContainerRole,
    ContainerState,
    Pod,
    PodCondition,
    PodContainer,
    PodDetail,
    PodProbe,
    PodStatus,
} from '../../../shared/k8s/pods.js';
import type { Usage } from '../../../shared/k8s/metrics.js';
import { apis, listItems, readOrNull, resolveObjectNamespace } from '../client.js';
import { withK8s } from '../errors.js';
import { ownerLabel } from './controller.js';
import { age, ago, cpuToMillicores, dash, memToMi, toPairs } from '../format.js';

export { toPairs };
import { containerUsage, ensureSampler, podUsage } from '../sampler.js';

/*
 * Pure transforms first, exported for tests and for the watch stream; thin readers at the end.
 */

/**
 * Terminating and waiting reasons outrank the phase, since the phase still says Running for them.
 * Init containers count too: one that crash-loops or cannot pull holds the whole pod in Pending.
 */
export function derivePodStatus(pod: V1Pod): PodStatus {
    if (pod.metadata?.deletionTimestamp) return 'Terminating';
    const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    const waiting = new Set(statuses.map((cs) => cs.state?.waiting?.reason));
    if (waiting.has('CrashLoopBackOff')) return 'CrashLoop';
    if (waiting.has('ImagePullBackOff') || waiting.has('ErrImagePull')) return 'Error';
    switch (pod.status?.phase) {
        case 'Running':
            return 'Running';
        case 'Pending':
            return 'Pending';
        case 'Succeeded':
            return 'Succeeded';
        case 'Failed':
            return 'Failed';
        default:
            return 'Unknown';
    }
}

/**
 * `usage` is the latest metrics-server sample for the pod; zero usage when there is none yet. The
 * ready ratio counts native sidecars (init containers with `restartPolicy: Always`) as kubectl does,
 * and restarts include every init container's.
 */
export function toPod(pod: V1Pod, now = Date.now(), usage?: Usage): Pod {
    const statuses = pod.status?.containerStatuses ?? [];
    const initStatuses = pod.status?.initContainerStatuses ?? [];
    const containers = pod.spec?.containers ?? [];
    const sidecars = new Set(
        (pod.spec?.initContainers ?? []).filter((c) => c.restartPolicy === 'Always').map((c) => c.name),
    );
    const sidecarStatuses = initStatuses.filter((cs) => sidecars.has(cs.name));
    const readyCount = [...statuses, ...sidecarStatuses].filter((cs) => cs.ready).length;
    return {
        name: pod.metadata?.name ?? '',
        namespace: pod.metadata?.namespace ?? 'default',
        status: derivePodStatus(pod),
        ready: `${readyCount}/${(containers.length || statuses.length) + sidecars.size}`,
        restarts: [...initStatuses, ...statuses].reduce((sum, cs) => sum + cs.restartCount, 0),
        age: age(pod.metadata?.creationTimestamp, now),
        node: dash(pod.spec?.nodeName),
        owner: ownerLabel(pod.metadata),
        cpu: usage?.cpu ?? 0,
        mem: usage?.mem ?? 0,
        cpuLimit: containers.reduce((sum, c) => sum + cpuToMillicores(c.resources?.limits?.cpu), 0),
        memLimit: containers.reduce((sum, c) => sum + memToMi(c.resources?.limits?.memory), 0),
    };
}

export function probeSpec(probe?: V1Probe): string | null {
    if (!probe) return null;
    const period = probe.periodSeconds != null ? ` · ${probe.periodSeconds}s` : '';
    if (probe.httpGet) return `httpGet ${probe.httpGet.path ?? '/'}:${probe.httpGet.port}${period}`;
    if (probe.tcpSocket) return `tcpSocket :${probe.tcpSocket.port}${period}`;
    if (probe.exec) return `exec ${(probe.exec.command ?? []).join(' ')}${period}`;
    if (probe.grpc) return `grpc :${probe.grpc.port}${period}`;
    return `probe${period}`;
}

export function containerProbes(c: V1Container): PodProbe[] {
    const specs: Array<[PodProbe['kind'], V1Probe | undefined]> = [
        ['Liveness', c.livenessProbe],
        ['Readiness', c.readinessProbe],
        ['Startup', c.startupProbe],
    ];
    return specs.flatMap(([kind, probe]) => {
        const spec = probeSpec(probe);
        return spec ? [{ kind, spec }] : [];
    });
}

export function containerState(cs?: V1ContainerStatus): ContainerState {
    if (!cs) return 'Unknown';
    if (cs.state?.running) return 'Running';
    if (cs.state?.terminated) return cs.state.terminated.reason === 'Completed' ? 'Completed' : 'Failed';
    if (cs.state?.waiting) return cs.state.waiting.reason === 'CrashLoopBackOff' ? 'CrashLoop' : 'Pending';
    return 'Unknown';
}

export function toContainer(
    c: V1Container,
    cs: V1ContainerStatus | undefined,
    now = Date.now(),
    role: ContainerRole = 'app',
    usage?: Usage,
): PodContainer {
    const requests = c.resources?.requests ?? {};
    const limits = c.resources?.limits ?? {};
    return {
        name: c.name,
        role,
        image: dash(c.image),
        imageId: dash(cs?.imageID?.split('@').pop()),
        pullPolicy: c.imagePullPolicy ?? 'IfNotPresent',
        state: containerState(cs),
        started: cs?.state?.running?.startedAt ? ago(cs.state.running.startedAt, now) : '—',
        restarts: cs?.restartCount ?? 0,
        cpuRequest: dash(requests.cpu),
        cpuLimit: dash(limits.cpu),
        memRequest: dash(requests.memory),
        memLimit: dash(limits.memory),
        ports: (c.ports ?? []).map((p) => `${p.containerPort}/${p.protocol ?? 'TCP'}`),
        probes: containerProbes(c),
        cpuUsed: usage?.cpu ?? null,
        memUsed: usage?.mem ?? null,
        // The request as a number, so a row can compare it with usage without parsing quantities.
        cpuRequested: requests.cpu ? cpuToMillicores(requests.cpu) : null,
        memRequested: requests.memory ? memToMi(requests.memory) : null,
    };
}

export function toConditions(pod: V1Pod, now = Date.now()): PodCondition[] {
    return (pod.status?.conditions ?? []).map((c) => ({
        type: c.type,
        ok: c.status === 'True',
        time: c.lastTransitionTime ? ago(c.lastTransitionTime, now) : '—',
    }));
}

/**
 * Every container of a pod in the order they matter: init steps first, since they ran first and a
 * pod stuck on one is stuck there; then the app's own; then anything attached for debugging. Each
 * carries its role, so the screen can say which is which rather than showing one flat list.
 */
export function toContainers(
    pod: V1Pod,
    now = Date.now(),
    usageOf: (container: string) => Usage | undefined = () => undefined,
): PodContainer[] {
    const statusesOf = (list?: V1ContainerStatus[]) => new Map((list ?? []).map((cs) => [cs.name, cs]));
    const init = statusesOf(pod.status?.initContainerStatuses);
    const app = statusesOf(pod.status?.containerStatuses);
    const ephemeral = statusesOf(pod.status?.ephemeralContainerStatuses);
    return [
        ...(pod.spec?.initContainers ?? []).map((c) => toContainer(c, init.get(c.name), now, 'init', usageOf(c.name))),
        ...(pod.spec?.containers ?? []).map((c) => toContainer(c, app.get(c.name), now, 'app', usageOf(c.name))),
        ...(pod.spec?.ephemeralContainers ?? []).map((c) =>
            toContainer(c as V1Container, ephemeral.get(c.name), now, 'ephemeral', usageOf(c.name)),
        ),
    ];
}

export function toPodDetail(
    pod: V1Pod,
    now = Date.now(),
    usage?: Usage,
    usageOf?: (container: string) => Usage | undefined,
): PodDetail {
    return {
        ...toPod(pod, now, usage),
        podIP: dash(pod.status?.podIP),
        hostIP: dash(pod.status?.hostIP),
        qos: dash(pod.status?.qosClass),
        dnsPolicy: dash(pod.spec?.dnsPolicy),
        serviceAccount: dash(pod.spec?.serviceAccountName),
        conditions: toConditions(pod, now),
        containers: toContainers(pod, now, usageOf),
        labels: toPairs(pod.metadata?.labels),
        annotations: toPairs(pod.metadata?.annotations),
    };
}

/** Latest sampled usage for a pod object; also makes sure sampling is running for the next read. */
export function usageFor(pod: V1Pod): Usage | undefined {
    ensureSampler();
    return podUsage(pod.metadata?.namespace ?? 'default', pod.metadata?.name ?? '');
}

export function listPods(namespace?: string): Promise<Pod[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().core.listNamespacedPod({ namespace: ns }),
            () => apis().core.listPodForAllNamespaces(),
        );
        return items.map((pod) => toPod(pod, Date.now(), usageFor(pod)));
    });
}

/**
 * Null when the pod does not exist, so the UI shows "not found". Without a resolvable namespace the
 * lookup is refused rather than guessed: routes carry the namespace, so this only happens for a
 * hand-typed URL while "all namespaces" is active.
 */
export function getPod(name: string, namespace?: string): Promise<PodDetail | null> {
    return withK8s('resources.get', async () => {
        const ns = resolveObjectNamespace(namespace);
        if (!ns) return null;
        const pod = await readOrNull(() => apis().core.readNamespacedPod({ name, namespace: ns }));
        if (!pod) return null;
        // Each container's own usage, so a row can put it beside the request it asked for.
        return toPodDetail(pod, Date.now(), usageFor(pod), (container) => containerUsage(ns, name, container));
    });
}
