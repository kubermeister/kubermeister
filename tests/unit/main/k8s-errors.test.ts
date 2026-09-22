import { ApiException } from '@kubernetes/client-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    K8sError,
    readTimeoutMs,
    setReadTimeoutSec,
    timeoutDetail,
    toK8sError,
    withK8s,
} from '../../../src/main/k8s/errors';
import { currentAbortSignal } from '../../../src/main/k8s/abort';
import { ExecPluginError } from '../../../src/main/k8s/exec-auth';

async function failWith(error: unknown): Promise<K8sError> {
    try {
        await withK8s('op', () => Promise.reject(error));
    } catch (caught) {
        return caught as K8sError;
    }
    throw new Error('expected withK8s to reject');
}

describe('withK8s', () => {
    it('returns the value of a successful call', async () => {
        await expect(withK8s('op', () => Promise.resolve(42))).resolves.toBe(42);
    });

    it('classifies HTTP statuses from the client exception', async () => {
        const cases: Array<[number, string]> = [
            [403, 'forbidden'],
            [401, 'unauthorized'],
            [404, 'notFound'],
            [409, 'conflict'],
            [400, 'invalid'],
            [422, 'invalid'],
        ];
        for (const [status, kind] of cases) {
            const error = await failWith(new ApiException(status, 'http dump', { message: 'server says' }, {}));
            expect(error.kind, `status ${status}`).toBe(kind);
            expect(error.op).toBe('op');
            expect(error.name).toBe('K8sError');
        }
    });

    it('uses the server Status.message as detail for write-path failures', async () => {
        const conflict = await failWith(
            new ApiException(409, 'dump', { message: 'services "web" already exists' }, {}),
        );
        expect(conflict.message).toBe('[conflict] services "web" already exists');
        const invalid = await failWith(new ApiException(422, 'dump', { message: 'spec.ports: Required value' }, {}));
        expect(invalid.message).toBe('[invalid] spec.ports: Required value');
    });

    it('falls back to the exception message when the body has no message', async () => {
        const error = await failWith(new ApiException(409, 'raw dump', null, {}));
        expect(error.message).toMatch(/^\[conflict\] /);
        expect(error.message).toContain('raw dump');
    });

    it('reads numeric codes and statusCodes from plain error objects', async () => {
        expect((await failWith({ code: 403 })).kind).toBe('forbidden');
        expect((await failWith({ statusCode: 404 })).kind).toBe('notFound');
    });

    it('treats connection, DNS and TLS failures as unreachable, including nested causes', async () => {
        expect((await failWith(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).kind).toBe('unreachable');
        const nested = new Error('fetch failed', { cause: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }) });
        expect((await failWith(nested)).kind).toBe('unreachable');
        const tls = new Error('tls', { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
        expect((await failWith(tls)).kind).toBe('unreachable');
        const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
        expect((await failWith(aborted)).kind).toBe('unreachable');
    });

    it('reads undici codes nested under a bare "fetch failed", as the client library throws them', async () => {
        const connectTimeout = Object.assign(new Error('Connect Timeout Error (attempted address: 10.0.0.1:6443)'), {
            name: 'ConnectTimeoutError',
            code: 'UND_ERR_CONNECT_TIMEOUT',
        });
        const fetchFailed = new TypeError('fetch failed', { cause: connectTimeout });
        const error = await failWith(fetchFailed);
        expect(error.kind).toBe('unreachable');
        expect(error.detail).toBe('The cluster API server is unreachable.');
        const socket = new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } });
        expect((await failWith(socket)).kind).toBe('unreachable');
        const aborted = new TypeError('fetch failed', { cause: { code: 'ECONNABORTED' } });
        expect((await failWith(aborted)).kind).toBe('unreachable');
    });

    it('reports a credential plugin failure as unauthorized with the guard sentence as detail', async () => {
        const plugin = new ExecPluginError('aws', 'The credential plugin "aws" failed: SSO session expired', null);
        const error = await failWith(plugin);
        expect(error.kind).toBe('unauthorized');
        expect(error.detail).toBe('The credential plugin "aws" failed: SSO session expired');
        expect(toK8sError('op', plugin)).toMatchObject({ kind: 'unauthorized', op: 'op' });
        const existing = new K8sError('forbidden', 'nope', 'inner');
        expect(toK8sError('op', existing)).toBe(existing);
    });

    it('finds connection codes inside AggregateError branches and survives cycles', async () => {
        const branch = Object.assign(new Error('v6'), { code: 'EHOSTUNREACH' });
        const aggregate = new AggregateError([new Error('v4'), branch], 'connect failed');
        expect((await failWith(aggregate)).kind).toBe('unreachable');
        const cyclic: { code: string; cause?: unknown } = { code: 'nothing' };
        cyclic.cause = cyclic;
        expect((await failWith(cyclic)).kind).toBe('unknown');
    });

    it('classifies the library\'s "No active cluster!" as a kubeconfig problem', async () => {
        const error = await failWith(new Error('No active cluster!'));
        expect(error.kind).toBe('kubeconfig');
        expect(error.detail).toBe('The current context names a cluster the kubeconfig does not define.');
    });

    it('reports anything else as unknown with the original message', async () => {
        const error = await failWith(new Error('boom'));
        expect(error.message).toBe('[unknown] boom');
        expect((await failWith('plain string')).message).toBe('[unknown] plain string');
        expect((await failWith(null)).kind).toBe('unknown');
    });

    it('passes an existing K8sError through unchanged', async () => {
        const original = new K8sError('forbidden', 'nope', 'inner');
        expect(await failWith(original)).toBe(original);
    });
});

describe('withK8s timeout', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('rejects as a timeout, naming the ceiling, when the call outlives it', async () => {
        const pending = withK8s('slow', () => new Promise<never>(() => {}), 1_000);
        const assertion = expect(pending).rejects.toMatchObject({
            kind: 'timeout',
            op: 'slow',
            detail: 'The cluster did not answer within 1 s. It may be busy, or the connection slow.',
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await assertion;
        expect(timeoutDetail(15_000)).toBe(
            'The cluster did not answer within 15 s. It may be busy, or the connection slow.',
        );
    });

    it('takes its default ceiling from the read-timeout setting, sixty seconds until one is applied', async () => {
        expect(readTimeoutMs()).toBe(60_000);
        setReadTimeoutSec(2);
        try {
            expect(readTimeoutMs()).toBe(2_000);
            const pending = withK8s('slow', () => new Promise<never>(() => {}));
            // The matcher must be listening before the timer fires, or the rejection is unhandled.
            const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout', detail: timeoutDetail(2_000) });
            await vi.advanceTimersByTimeAsync(2_000);
            await assertion;
        } finally {
            setReadTimeoutSec(60);
        }
        expect(readTimeoutMs()).toBe(60_000);
    });

    it('does not fire the timeout after a fast call', async () => {
        await expect(withK8s('fast', () => Promise.resolve('ok'), 1_000)).resolves.toBe('ok');
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('the signal a call runs under', () => {
    it('is in scope for the call and gone once it has answered', async () => {
        let inside: AbortSignal | undefined;
        await withK8s('op', async () => {
            inside = currentAbortSignal();
        });
        expect(inside).toBeInstanceOf(AbortSignal);
        expect(inside?.aborted, 'a call that answered in time is not aborted').toBe(false);
        expect(currentAbortSignal()).toBeUndefined();
    });

    it('is aborted when the ceiling fires, which is what stops the call itself', async () => {
        vi.useFakeTimers();
        try {
            let inside: AbortSignal | undefined;
            const pending = withK8s(
                'slow',
                () =>
                    new Promise<never>(() => {
                        inside = currentAbortSignal();
                    }),
                1_000,
            );
            const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
            expect(inside?.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(1_000);
            await assertion;
            expect(inside?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('carries the ceiling of the call it is nested in, so an outer timeout ends the inner one', async () => {
        vi.useFakeTimers();
        try {
            let inner: AbortSignal | undefined;
            const pending = withK8s(
                'outer',
                () =>
                    withK8s(
                        'inner',
                        () =>
                            new Promise<never>(() => {
                                inner = currentAbortSignal();
                            }),
                        10_000,
                    ),
                1_000,
            );
            const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout', op: 'outer' });
            await vi.advanceTimersByTimeAsync(1_000);
            await assertion;
            expect(inner?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('is absent from a call made outside any ceiling, which is what leaves the drain loop alone', () => {
        expect(currentAbortSignal()).toBeUndefined();
    });
});
