import * as net from 'node:net';
import { Writable } from 'node:stream';
import { PortForward, type V1Endpoints, type V1Service } from '@kubernetes/client-node';
import { streamSchemas, type StreamController, type StreamSend } from '../../shared/streams.js';
import { kubeConfig } from './client.js';
import { apis, readOrNull } from './client.js';
import { reportMissingPod } from './pod-target.js';

/** Where one forwarded connection goes: a pod, and the port on it. */
export interface ForwardTarget {
    pod: string;
    port: number;
}

/**
 * A ready pod behind a service, and the port on it that a service port reaches: the service's
 * `targetPort`, as the endpoints resolved it. A named `targetPort` can be a different number on
 * different pods, and the endpoints group pods by the numbers they give it, so the port is read off
 * the same subset as the pod rather than off the service. Endpoint ports carry the service port's
 * name, which is empty only for a service's single unnamed port. Null when the service does not
 * declare that port or has no ready pod behind it.
 */
export function serviceTargetOf(
    service: V1Service | undefined,
    endpoints: V1Endpoints | undefined,
    servicePort: number,
): ForwardTarget | null {
    const declared = service?.spec?.ports?.find((port) => port.port === servicePort);
    if (!declared) return null;
    const name = declared.name ?? '';
    for (const subset of endpoints?.subsets ?? []) {
        const port = subset.ports?.find((candidate) => (candidate.name ?? '') === name)?.port;
        if (port === undefined) continue;
        for (const address of subset.addresses ?? []) {
            if (address.targetRef?.kind === 'Pod' && address.targetRef.name)
                return { pod: address.targetRef.name, port };
        }
    }
    return null;
}

type PodWebSocket = Awaited<ReturnType<PortForward['portForward']>>;

/**
 * Forward a loopback TCP port to a pod port. Each incoming connection gets its own websocket to
 * the pod, piped both ways, and each side's close ends the other. The websocket is closed when the
 * local socket closes: the client only closes it on stream `end`, while a destroyed socket emits
 * `close`, so without this every connection alive at stop would leak a websocket to the API server.
 * The local socket is ended when the websocket closes, which is how the pod side hangs up, since the
 * client adds no close handler of its own: without it a connection the server let go stays open
 * locally and the next request on it hangs.
 */
export async function startPodPortForward(rawInput: unknown, send: StreamSend): Promise<StreamController> {
    const input = streamSchemas['pods.portForward'].parse(rawInput);

    /**
     * Where a connection goes. For a pod that is the pod and the port asked for; for a service it is
     * whichever of its endpoints is ready at the moment the connection arrives, on the port that
     * pod serves the service port on, so a forward to a service keeps working across a rollout
     * rather than dying with the pod it first found.
     */
    const resolveTarget = async (): Promise<ForwardTarget | null> => {
        if (input.kind === 'Pod') {
            const pod = await readOrNull(() =>
                apis().core.readNamespacedPod({ name: input.name, namespace: input.namespace }),
            );
            return pod ? { pod: input.name, port: input.targetPort } : null;
        }
        const [service, endpoints] = await Promise.all([
            readOrNull(() => apis().core.readNamespacedService({ name: input.name, namespace: input.namespace })),
            readOrNull(() => apis().core.readNamespacedEndpoints({ name: input.name, namespace: input.namespace })),
        ]);
        return serviceTargetOf(service, endpoints, input.targetPort);
    };

    const first = await resolveTarget();
    if (!first) {
        if (input.kind === 'Pod') return reportMissingPod(send, input.name, input.namespace);
        send({ type: 'error', message: `service "${input.namespace}/${input.name}" has no ready endpoints` });
        send({ type: 'end' });
        return { stop: () => {} };
    }
    let current = first.pod;

    const forward = new PortForward(kubeConfig());
    const sockets = new Set<net.Socket>();

    const server = net.createServer((socket) => {
        sockets.add(socket);
        let ws: PodWebSocket | undefined;
        const closeWs = () => {
            try {
                ws?.close();
            } catch {
                // already closed
            }
            ws = undefined;
        };
        socket.on('close', () => {
            sockets.delete(socket);
            closeWs();
        });
        socket.on('error', () => socket.destroy());
        // Re-resolved per connection, not once at start: that is what carries a service forward
        // across a rollout, and it costs one read on a connection that is about to do far more.
        void resolveTarget()
            .then(async (target) => {
                if (!target) throw new Error(`${input.name} has no ready pod to forward to`);
                // The status keeps naming the port the user chose; only the pod it reaches changes.
                if (target.pod !== current) {
                    current = target.pod;
                    send({
                        type: 'data',
                        data: {
                            status: 'listening',
                            localPort: input.localPort,
                            targetPort: input.targetPort,
                            pod: target.pod,
                        },
                    });
                }
                // The error channel carries the kubelet's sentence when it cannot reach the pod port,
                // such as a connection refused, and the websocket closes right after it.
                let failure = '';
                const errors = new Writable({
                    write(chunk: Buffer, _encoding, done) {
                        failure += chunk.toString('utf8');
                        done();
                    },
                });
                const podSocket = await forward.portForward(
                    input.namespace,
                    target.pod,
                    [target.port],
                    socket,
                    errors,
                    socket,
                );
                ws = podSocket;
                podSocket.on('close', () => {
                    ws = undefined;
                    if (socket.destroyed) return;
                    if (!failure) {
                        // Ended rather than destroyed, so what the pod sent before hanging up still arrives.
                        socket.end();
                        return;
                    }
                    send({ type: 'error', message: failure.trim() });
                    // A reset is what the client would have got from the pod port itself.
                    socket.resetAndDestroy();
                });
                if (socket.destroyed) closeWs();
            })
            .catch((error: unknown) => {
                send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
                socket.destroy();
            });
    });

    server.on('error', (error) => send({ type: 'error', message: error.message }));
    await new Promise<void>((resolve) => {
        server.listen(input.localPort, '127.0.0.1', () => {
            send({
                type: 'data',
                data: {
                    status: 'listening',
                    localPort: input.localPort,
                    targetPort: input.targetPort,
                    pod: current,
                },
            });
            resolve();
        });
        server.once('error', () => resolve());
    });

    return {
        stop: () => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close();
        },
    };
}
