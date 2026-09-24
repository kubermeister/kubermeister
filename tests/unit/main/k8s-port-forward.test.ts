import { once } from 'node:events';
import * as net from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const portForward = vi.fn();
vi.mock('@kubernetes/client-node', async () => ({
    ...(await vi.importActual<typeof import('@kubernetes/client-node')>('@kubernetes/client-node')),
    PortForward: class {
        portForward = portForward;
    },
}));
const readOrNull = vi.fn();
const core = { readNamespacedPod: vi.fn(), readNamespacedService: vi.fn(), readNamespacedEndpoints: vi.fn() };
vi.mock('../../../src/main/k8s/client.js', () => ({
    kubeConfig: () => ({}),
    apis: () => ({ core }),
    readOrNull,
}));

const { startPodPortForward } = await import('../../../src/main/k8s/port-forward.js');

async function freePort(): Promise<number> {
    return new Promise((resolve) => {
        const probe = net.createServer().listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as net.AddressInfo;
            probe.close(() => resolve(port));
        });
    });
}

function connect(port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
        socket.on('error', reject);
    });
}

describe('resolving a service port to a pod port', () => {
    const service = {
        spec: {
            ports: [
                { name: 'http', port: 80, targetPort: 'http' },
                { name: 'metrics', port: 9100, targetPort: 9090 },
            ],
        },
    };

    it('goes to the port the pod serves, which the endpoints carry under the service port name', async () => {
        const { serviceTargetOf } = await import('../../../src/main/k8s/port-forward.js');
        const endpoints = {
            subsets: [
                {
                    addresses: [{ ip: '10.0.0.2', targetRef: { kind: 'Pod', name: 'web-2' } }],
                    ports: [
                        { name: 'http', port: 8080 },
                        { name: 'metrics', port: 9090 },
                    ],
                },
            ],
        };
        expect(serviceTargetOf(service as never, endpoints as never, 80)).toEqual({ pod: 'web-2', port: 8080 });
        expect(serviceTargetOf(service as never, endpoints as never, 9100)).toEqual({ pod: 'web-2', port: 9090 });
    });

    it('follows a named target port to the number each set of pods gives it', async () => {
        const { serviceTargetOf } = await import('../../../src/main/k8s/port-forward.js');
        // Two subsets exist when pods behind one service name the same port differently.
        const endpoints = {
            subsets: [
                { notReadyAddresses: [{ ip: '10.0.0.1' }], ports: [{ name: 'http', port: 8080 }] },
                {
                    addresses: [{ ip: '10.0.0.3', targetRef: { kind: 'Pod', name: 'web-3' } }],
                    ports: [{ name: 'http', port: 8081 }],
                },
            ],
        };
        expect(serviceTargetOf(service as never, endpoints as never, 80)).toEqual({ pod: 'web-3', port: 8081 });
    });

    it('matches the one unnamed port of a single-port service', async () => {
        const { serviceTargetOf } = await import('../../../src/main/k8s/port-forward.js');
        const single = { spec: { ports: [{ port: 80, targetPort: 8080 }] } };
        const endpoints = {
            subsets: [
                { addresses: [{ ip: '10.0.0.2', targetRef: { kind: 'Pod', name: 'web-2' } }], ports: [{ port: 8080 }] },
            ],
        };
        expect(serviceTargetOf(single as never, endpoints as never, 80)).toEqual({ pod: 'web-2', port: 8080 });
    });

    it('finds nothing without a ready pod, a service, or a port the service declares', async () => {
        const { serviceTargetOf } = await import('../../../src/main/k8s/port-forward.js');
        const endpoints = {
            subsets: [
                {
                    addresses: [{ ip: '10.0.0.2', targetRef: { kind: 'Pod', name: 'web-2' } }],
                    ports: [{ name: 'http', port: 8080 }],
                },
            ],
        };
        expect(serviceTargetOf(service as never, endpoints as never, 443)).toBeNull();
        expect(serviceTargetOf(undefined, endpoints as never, 80)).toBeNull();
        expect(
            serviceTargetOf(service as never, { subsets: [{ notReadyAddresses: [{ ip: '10.0.0.3' }] }] } as never, 80),
        ).toBeNull();
        expect(serviceTargetOf(service as never, undefined, 80)).toBeNull();
    });
});

describe('startPodPortForward', () => {
    // One per test: a connection a test leaves closing reaches the websocket it was handed, so a
    // shared one counted the previous test's close in the next test's assertions.
    let ws: { close: ReturnType<typeof vi.fn> };

    /**
     * The local socket the next connection is handed to the pod with, once the forward reaches it.
     * Awaited rather than polled, so a test waits as long as the connection takes instead of the one
     * second `vi.waitFor` allows by default.
     */
    function nextForward(): Promise<net.Socket> {
        return new Promise((resolve) => {
            portForward.mockImplementationOnce(async (...args: unknown[]) => {
                resolve(args[3] as net.Socket);
                return ws;
            });
        });
    }

    beforeEach(() => {
        portForward.mockReset();
        ws = { close: vi.fn() };
        readOrNull.mockReset();
        readOrNull.mockResolvedValue({ metadata: { name: 'web-1' } });
        portForward.mockResolvedValue(ws);
    });

    it('listens on loopback, reports listening, forwards each connection, and closes everything on stop', async () => {
        const localPort = await freePort();
        const send = vi.fn();
        const ctl = await startPodPortForward(
            { name: 'web-1', namespace: 'team-a', targetPort: 8080, localPort },
            send,
        );
        // The pod being forwarded to is named, which for a service is whichever endpoint was ready.
        expect(send).toHaveBeenCalledWith({
            type: 'data',
            data: { status: 'listening', localPort, targetPort: 8080, pod: 'web-1' },
        });

        const forwarded = nextForward();
        const client = await connect(localPort);
        const local = await forwarded;
        expect(portForward).toHaveBeenCalledWith('team-a', 'web-1', [8080], local, null, local);
        await new Promise((resolve) => setImmediate(resolve));

        const closed = Promise.all([once(local, 'close'), once(client, 'close')]);
        ctl.stop();
        await closed;
        expect(ws.close).toHaveBeenCalledOnce();
        await expect(connect(localPort)).rejects.toThrow();
    });

    it('forwards a service port to the port its pods serve, and still reports the service port', async () => {
        readOrNull.mockImplementation(async (read: () => Promise<unknown>) => read());
        core.readNamespacedService.mockResolvedValue({
            spec: { ports: [{ name: 'http', port: 80, targetPort: 8080 }] },
        });
        core.readNamespacedEndpoints.mockResolvedValue({
            subsets: [
                {
                    addresses: [{ ip: '10.0.0.2', targetRef: { kind: 'Pod', name: 'web-2' } }],
                    ports: [{ name: 'http', port: 8080 }],
                },
            ],
        });
        const localPort = await freePort();
        const send = vi.fn();
        const ctl = await startPodPortForward(
            { kind: 'Service', name: 'web', namespace: 'team-a', targetPort: 80, localPort },
            send,
        );
        expect(send).toHaveBeenCalledWith({
            type: 'data',
            data: { status: 'listening', localPort, targetPort: 80, pod: 'web-2' },
        });
        const forwarded = nextForward();
        const client = await connect(localPort);
        const local = await forwarded;
        expect(portForward).toHaveBeenCalledWith('team-a', 'web-2', [8080], local, null, local);
        const closed = once(local, 'close');
        client.destroy();
        await closed;
        ctl.stop();
    });

    it('closes the pod websocket when the local socket closes on its own', async () => {
        const localPort = await freePort();
        const ctl = await startPodPortForward(
            { name: 'web-1', namespace: 'team-a', targetPort: 80, localPort },
            vi.fn(),
        );
        const forwarded = nextForward();
        const client = await connect(localPort);
        const local = await forwarded;
        await new Promise((resolve) => setImmediate(resolve));
        const closed = once(local, 'close');
        client.destroy();
        await closed;
        expect(ws.close).toHaveBeenCalledOnce();
        ctl.stop();
    });

    it('reports a forward failure and drops that connection', async () => {
        portForward.mockRejectedValue(new Error('upgrade refused'));
        const localPort = await freePort();
        const send = vi.fn();
        const ctl = await startPodPortForward({ name: 'web-1', namespace: 'team-a', targetPort: 80, localPort }, send);
        const client = await connect(localPort);
        await new Promise<void>((resolve) => client.once('close', () => resolve()));
        expect(send).toHaveBeenCalledWith({ type: 'error', message: 'upgrade refused' });
        ctl.stop();
    });

    it('reports a port that is already in use', async () => {
        const blocker = net.createServer().listen(0, '127.0.0.1');
        await new Promise((resolve) => blocker.once('listening', resolve));
        const { port } = blocker.address() as net.AddressInfo;
        const send = vi.fn();
        const ctl = await startPodPortForward(
            { name: 'web-1', namespace: 'team-a', targetPort: 80, localPort: port },
            send,
        );
        expect(send).toHaveBeenCalledWith({ type: 'error', message: expect.stringContaining('EADDRINUSE') });
        ctl.stop();
        blocker.close();
    });

    it('reports a missing pod and rejects bad ports', async () => {
        readOrNull.mockResolvedValue(undefined);
        const send = vi.fn();
        await startPodPortForward({ name: 'gone', namespace: 'team-a', targetPort: 80, localPort: 40000 }, send);
        expect(send).toHaveBeenNthCalledWith(1, { type: 'error', message: 'pod "team-a/gone" not found' });
        await expect(
            startPodPortForward({ name: 'x', namespace: 'y', targetPort: 0, localPort: 1 }, vi.fn()),
        ).rejects.toThrow();
        await expect(
            startPodPortForward({ name: 'x', namespace: 'y', targetPort: 80, localPort: 70000 }, vi.fn()),
        ).rejects.toThrow();
    });
});
