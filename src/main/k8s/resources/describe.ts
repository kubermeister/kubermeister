import type { CoreV1Event, V1Container, V1Node, V1Pod, V1Taint } from '@kubernetes/client-node';
import type {
    DescribeBlock,
    DescribeDocument,
    DescribeInput,
    DescribeRow,
    DescribeSection,
} from '../../../shared/k8s/describe.js';
import { apis, isSafeSelectorValue, readOrNull, resolveObjectNamespace } from '../client.js';
import { K8sError, withK8s } from '../errors.js';
import { ago, joinSelector } from '../format.js';
import { eventTimestamp, sortedByTimeDesc } from './events.js';
import { controllerRef } from './controller.js';

/*
 * The flat reading of an object: what `kubectl describe` prints, built from the same objects the
 * detail screens already read. Everything here is a pure transform over a Kubernetes object plus
 * its events, so the whole view is testable without a cluster.
 */

const row = (label: string, value: string | number | undefined | null): DescribeRow => ({
    label,
    value: value === undefined || value === null || value === '' ? '—' : String(value),
});

/** Key/value pairs as one line, the way describe prints labels and annotations. */
const pairs = (source?: Record<string, string>): string => joinSelector(source, '—');

const section = (title: string, rows: DescribeRow[], blocks: DescribeBlock[] = []): DescribeSection => ({
    title,
    rows,
    blocks,
});

/** Events, newest first, as one block: the part of describe people scroll to first. */
export function eventSection(events: CoreV1Event[], now = Date.now()): DescribeSection {
    const recent = sortedByTimeDesc(events).slice(0, 20);
    if (recent.length === 0) return section('Events', [row('', 'No events.')]);
    return section(
        'Events',
        recent.map((event) => ({
            label: `${event.type ?? 'Normal'} ${event.reason ?? ''}`.trim(),
            value: `${ago(eventTimestamp(event), now)} · ${event.count && event.count > 1 ? `x${event.count} · ` : ''}${event.message ?? ''}`,
        })),
    );
}

const containerBlock = (container: V1Container, pod: V1Pod, kind: string): DescribeBlock => {
    const status = [
        ...(pod.status?.initContainerStatuses ?? []),
        ...(pod.status?.containerStatuses ?? []),
        ...(pod.status?.ephemeralContainerStatuses ?? []),
    ].find((one) => one.name === container.name);
    const state = status?.state ?? {};
    const running = state.running ? `Running since ${state.running.startedAt ?? '—'}` : undefined;
    const waiting = state.waiting ? `Waiting: ${state.waiting.reason ?? '—'}` : undefined;
    const terminated = state.terminated
        ? `Terminated: ${state.terminated.reason ?? '—'} (exit ${state.terminated.exitCode ?? '—'})`
        : undefined;
    return {
        title: `${container.name}${kind === 'app' ? '' : ` (${kind})`}`,
        rows: [
            row('Image', container.image),
            row('Image ID', status?.imageID),
            row(
                'Ports',
                (container.ports ?? []).map((port) => `${port.containerPort}/${port.protocol ?? 'TCP'}`).join(', '),
            ),
            row('Command', (container.command ?? []).join(' ')),
            row('Args', (container.args ?? []).join(' ')),
            row('State', running ?? waiting ?? terminated),
            row('Ready', String(status?.ready ?? false)),
            row('Restarts', status?.restartCount ?? 0),
            row('Requests', pairs(container.resources?.requests as Record<string, string> | undefined)),
            row('Limits', pairs(container.resources?.limits as Record<string, string> | undefined)),
            row('Environment', `${(container.env ?? []).length} variable(s)`),
            row(
                'Mounts',
                (container.volumeMounts ?? []).map((mount) => `${mount.mountPath} from ${mount.name}`).join(', '),
            ),
        ],
    };
};

/** The flat reading of a pod: where it runs, what it runs, and what has happened to it. */
export function describePod(pod: V1Pod, events: CoreV1Event[], now = Date.now()): DescribeDocument {
    const owner = controllerRef(pod.metadata);
    const containers: DescribeBlock[] = [
        ...(pod.spec?.initContainers ?? []).map((c) => containerBlock(c, pod, 'init')),
        ...(pod.spec?.containers ?? []).map((c) => containerBlock(c, pod, 'app')),
        ...(pod.spec?.ephemeralContainers ?? []).map((c) => containerBlock(c as V1Container, pod, 'ephemeral')),
    ];
    return {
        kind: 'Pod',
        name: pod.metadata?.name ?? '',
        namespace: pod.metadata?.namespace ?? null,
        sections: [
            section('Overview', [
                row('Name', pod.metadata?.name),
                row('Namespace', pod.metadata?.namespace),
                row('Node', pod.spec?.nodeName),
                row('Start time', pod.status?.startTime ? String(pod.status.startTime) : undefined),
                row('Status', pod.status?.phase),
                row('Reason', pod.status?.reason),
                row('IP', pod.status?.podIP),
                row('Controlled by', owner ? `${owner.kind}/${owner.name}` : undefined),
                row('Service account', pod.spec?.serviceAccountName),
                row('QoS class', pod.status?.qosClass),
                row('Node selector', pairs(pod.spec?.nodeSelector)),
                row('Tolerations', (pod.spec?.tolerations ?? []).map(tolerationText).join(', ')),
                row('Labels', pairs(pod.metadata?.labels)),
                row('Annotations', pairs(pod.metadata?.annotations)),
            ]),
            section('Containers', [], containers),
            section(
                'Conditions',
                (pod.status?.conditions ?? []).map((condition) =>
                    row(condition.type, `${condition.status}${condition.reason ? ` (${condition.reason})` : ''}`),
                ),
            ),
            section(
                'Volumes',
                (pod.spec?.volumes ?? []).map((volume) => row(volume.name, volumeSummary(volume))),
            ),
            eventSection(events, now),
        ],
    };
}

/**
 * What a volume is, in the one line describe gives it. A volume names its type by which field it
 * carries, so the type is read from the object's own shape rather than from a list this would have
 * to keep in step with the API.
 */
function volumeSummary(volume: NonNullable<NonNullable<V1Pod['spec']>['volumes']>[number]): string {
    const fields = volume as unknown as Record<string, unknown>;
    const kind = Object.keys(fields).find((key) => key !== 'name');
    if (!kind) return '—';
    const body = fields[kind] as Record<string, unknown> | undefined;
    const detail =
        (body?.claimName as string | undefined) ??
        (body?.secretName as string | undefined) ??
        ((body?.name as string | undefined) || undefined);
    return detail ? `${kind} (${detail})` : kind;
}

type Toleration = NonNullable<NonNullable<V1Pod['spec']>['tolerations']>[number];

const tolerationText = (toleration: Toleration): string =>
    [toleration.key ?? '*', toleration.operator, toleration.value, toleration.effect].filter(Boolean).join(' ');

const taintText = (taint: V1Taint): string => `${taint.key}=${taint.value ?? ''}:${taint.effect}`;

/** The flat reading of a node: what it offers, what it is carrying, and what it is complaining about. */
export function describeNode(node: V1Node, pods: V1Pod[], events: CoreV1Event[], now = Date.now()): DescribeDocument {
    const name = node.metadata?.name ?? '';
    const onNode = pods.filter((pod) => pod.spec?.nodeName === name);
    return {
        kind: 'Node',
        name,
        namespace: null,
        sections: [
            section('Overview', [
                row('Name', name),
                row('Roles', roles(node)),
                row('Unschedulable', String(node.spec?.unschedulable ?? false)),
                row('Taints', (node.spec?.taints ?? []).map(taintText).join(', ')),
                row('Labels', pairs(node.metadata?.labels)),
                row('Annotations', pairs(node.metadata?.annotations)),
            ]),
            section(
                'Conditions',
                (node.status?.conditions ?? []).map((condition) =>
                    row(condition.type, `${condition.status}${condition.reason ? ` (${condition.reason})` : ''}`),
                ),
            ),
            section(
                'Addresses',
                (node.status?.addresses ?? []).map((address) => row(address.type, address.address)),
            ),
            section(
                'Capacity',
                Object.entries(node.status?.capacity ?? {}).map(([key, value]) => row(key, String(value))),
            ),
            section(
                'Allocatable',
                Object.entries(node.status?.allocatable ?? {}).map(([key, value]) => row(key, String(value))),
            ),
            section(
                'System info',
                Object.entries(node.status?.nodeInfo ?? {}).map(([key, value]) => row(key, String(value))),
            ),
            section(
                'Pods',
                onNode.map((pod) => row(`${pod.metadata?.namespace}/${pod.metadata?.name}`, pod.status?.phase ?? '—')),
            ),
            eventSection(events, now),
        ],
    };
}

const ROLE_LABEL_PREFIX = 'node-role.kubernetes.io/';

function roles(node: V1Node): string {
    const found = Object.keys(node.metadata?.labels ?? {})
        .filter((label) => label.startsWith(ROLE_LABEL_PREFIX))
        .map((label) => label.slice(ROLE_LABEL_PREFIX.length))
        .filter(Boolean);
    return found.length > 0 ? found.join(', ') : 'worker';
}

/** Events about one pod, matched on its uid so a same-named predecessor's events are not its. */
async function podEvents(name: string, namespace: string, uid: string | undefined): Promise<CoreV1Event[]> {
    const res = await apis().core.listNamespacedEvent({ namespace });
    return res.items.filter((event) => (uid ? event.involvedObject?.uid === uid : event.involvedObject?.name === name));
}

/**
 * Events about one node, matched on kind and name: the kubelet records NodeReady, Rebooted and the
 * pressure conditions against a reference whose uid is the node's name, never its metadata uid.
 */
async function nodeEvents(name: string): Promise<CoreV1Event[]> {
    const res = await apis().core.listEventForAllNamespaces({
        fieldSelector: `involvedObject.kind=Node,involvedObject.name=${name}`,
    });
    return res.items.filter((event) => event.involvedObject?.kind === 'Node' && event.involvedObject.name === name);
}

/** The describe view of one object, or a classified error when it is not there. */
export function describeObject(input: DescribeInput): Promise<DescribeDocument> {
    const op = 'resources.describe';
    return withK8s(op, async () => {
        if (input.kind === 'Node') {
            // A node name is DNS-1123; anything else cannot be a node and must not reach a selector.
            if (!isSafeSelectorValue(input.name)) {
                throw new K8sError('invalid', `"${input.name}" is not a valid node name.`, op);
            }
            const node = await readOrNull(() => apis().core.readNode({ name: input.name }));
            if (!node) throw new K8sError('notFound', `Node "${input.name}" was not found.`, op);
            // Only this node's pods: the API server filters on spec.nodeName, so the cluster's other
            // pods never cross the wire for one node's describe.
            const [pods, events] = await Promise.all([
                apis().core.listPodForAllNamespaces({ fieldSelector: `spec.nodeName=${input.name}` }),
                nodeEvents(input.name),
            ]);
            return describeNode(node, pods.items, events);
        }

        const namespace = resolveObjectNamespace(input.namespace);
        if (!namespace) {
            throw new K8sError('invalid', `A namespace is required to describe pod "${input.name}".`, op);
        }
        const pod = await readOrNull(() => apis().core.readNamespacedPod({ name: input.name, namespace }));
        if (!pod) throw new K8sError('notFound', `Pod "${input.name}" was not found in namespace ${namespace}.`, op);
        const events = await podEvents(input.name, namespace, pod.metadata?.uid);
        return describePod(pod, events);
    });
}
