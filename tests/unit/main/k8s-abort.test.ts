import { HttpMethod, RequestContext, ResponseContext, createConfiguration } from '@kubernetes/client-node';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    abortMiddleware,
    abortable,
    currentAbortSignal,
    withAbortMiddleware,
    withAbortScope,
} from '../../../src/main/k8s/abort';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/settings';

let settings: Settings;
vi.mock('../../../src/main/settings/store.js', () => ({
    getSettings: () => settings,
    updateSettings: vi.fn(),
}));

const requestFor = () => new RequestContext('https://cluster.test/api/v1/pods', HttpMethod.GET);

describe('the call scope', () => {
    it('carries the signal of the call running here and nothing outside one', async () => {
        expect(currentAbortSignal()).toBeUndefined();
        const controller = new AbortController();
        await withAbortScope(controller.signal, async () => {
            expect(currentAbortSignal()).toBe(controller.signal);
            await Promise.resolve();
            expect(currentAbortSignal(), 'the signal survives an await inside the call').toBe(controller.signal);
        });
        expect(currentAbortSignal()).toBeUndefined();
    });

    it('closes when the call ends, so a timer the call left behind is not aborted with it', async () => {
        const controller = new AbortController();
        let leaked: () => AbortSignal | undefined = () => undefined;
        await withAbortScope(controller.signal, async () => {
            // A timer started inside the call inherits its async context and would otherwise read a
            // signal that has since been aborted.
            leaked = currentAbortSignal.bind(null);
            await new Promise<void>((done) => setTimeout(done, 0));
        });
        controller.abort();
        expect(leaked()).toBeUndefined();
    });

    it('closes when the call fails too', async () => {
        const controller = new AbortController();
        await expect(withAbortScope(controller.signal, () => Promise.reject(new Error('boom')))).rejects.toThrow(
            'boom',
        );
        expect(currentAbortSignal()).toBeUndefined();
    });
});

describe('abortMiddleware', () => {
    it('puts the current call signal on the request', async () => {
        const controller = new AbortController();
        const request = await withAbortScope(controller.signal, () => abortMiddleware.pre(requestFor()).toPromise());
        expect(request.getSignal()).toBe(controller.signal);
    });

    it('leaves a request made outside any ceiling without one', async () => {
        const request = await abortMiddleware.pre(requestFor()).toPromise();
        expect(request.getSignal()).toBeUndefined();
    });

    it('passes a response through untouched', async () => {
        const response = new ResponseContext(200, {}, {
            text: () => Promise.resolve(''),
            binary: () => Promise.resolve(Buffer.alloc(0)),
            stream: () => null,
        } as never);
        await expect(abortMiddleware.post(response).toPromise()).resolves.toBe(response);
    });
});

describe('abortable', () => {
    class FakeApi {
        constructor(readonly configuration: ReturnType<typeof createConfiguration>) {}
    }

    it('adds the middleware to what the library already configured, keeping the rest', () => {
        const base = createConfiguration();
        const client = new (abortable(FakeApi))(base);
        expect(client.configuration.middleware).toEqual([...base.middleware, abortMiddleware]);
        expect(client.configuration.baseServer).toBe(base.baseServer);
        expect(client.configuration.authMethods).toBe(base.authMethods);
        expect(base.middleware, 'the library array is copied, never appended to').not.toContain(abortMiddleware);
    });

    it('widens a configuration on its own too', () => {
        const base = createConfiguration();
        expect(withAbortMiddleware(base).middleware).toEqual([...base.middleware, abortMiddleware]);
    });
});

describe('a request the ceiling gives up on', () => {
    /**
     * A server that accepts the connection and never answers, which is the case the ceiling exists
     * for: the cluster is reachable, so nothing lower down gives up, and only the ceiling does.
     */
    let server: Server;
    let dir: string;
    let kubeconfigPath: string;
    let closed: Promise<void>;

    beforeAll(async () => {
        let onClose = (): void => {};
        closed = new Promise((done) => (onClose = done));
        let answered = false;
        server = createServer((_req, res) => {
            // The first read is answered so the connection is open and pooled by the time the one
            // this test is about is sent; a request still being connected would never reach here.
            if (!answered) {
                answered = true;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ apiVersion: 'v1', kind: 'PodList', metadata: {}, items: [] }));
                return;
            }
            res.on('close', () => onClose());
        });
        await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
        const { port } = server.address() as { port: number };
        dir = mkdtempSync(join(tmpdir(), 'km-abort-'));
        kubeconfigPath = join(dir, 'kubeconfig.yaml');
        writeFileSync(
            kubeconfigPath,
            [
                'apiVersion: v1',
                'kind: Config',
                'current-context: slow',
                'clusters:',
                '  - name: slow-cluster',
                `    cluster: { server: "http://127.0.0.1:${port}", insecure-skip-tls-verify: true }`,
                'users:',
                '  - name: slow-user',
                '    user: { token: slow-token }',
                'contexts:',
                '  - name: slow',
                '    context: { cluster: slow-cluster, user: slow-user, namespace: team-a }',
                '',
            ].join('\n'),
        );
    });

    afterAll(() => {
        server.close();
        rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
        settings = { ...DEFAULT_SETTINGS, connection: { kubeconfigPath } };
    });

    it('is cancelled rather than left in flight', async () => {
        const { apis } = await import('../../../src/main/k8s/client.js');
        const { withK8s } = await import('../../../src/main/k8s/errors.js');
        const list = () => apis().core.listNamespacedPod({ namespace: 'team-a' });
        await expect(withK8s('warm-up', list)).resolves.toMatchObject({ items: [] });

        const pending = withK8s('resources.list', list, 200);
        await expect(pending).rejects.toMatchObject({ kind: 'timeout', op: 'resources.list' });
        // The server sees the connection go: before the signal was threaded through, this request
        // stayed open for as long as the server held it.
        await expect(closed).resolves.toBeUndefined();
    });
});
