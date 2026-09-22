import { KubeConfig } from '@kubernetes/client-node';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withAbortScope } from '../../../src/main/k8s/abort';
import {
    ExecPluginError,
    describeExecFailure,
    execCommandOf,
    guardCredentialPlugins,
} from '../../../src/main/k8s/exec-auth';

const FIXTURE = resolve('tests/unit/fixtures/kubeconfig.yaml');

interface Authenticator {
    isAuthProvider(user: unknown): boolean;
    applyAuthentication(user: unknown, opts: unknown): Promise<void>;
    execFn?: (command: string, args?: readonly string[], options?: unknown) => ChildProcess;
}

function authenticatorsOf(kc: KubeConfig): Authenticator[] {
    return (kc as unknown as { authenticators: Authenticator[] }).authenticators;
}

describe('describeExecFailure', () => {
    it('names a plugin missing from PATH as such', () => {
        const spawnError = Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' });
        expect(describeExecFailure('aws', spawnError)).toBe(
            'The credential plugin "aws" was not found on the app\'s PATH.',
        );
    });

    it('quotes the first line of the plugin stderr and trims long lines', () => {
        const stderr = new Error('\n\nError loading SSO Token: Token for my-sso does not exist\nusage: aws ...\n');
        expect(describeExecFailure('aws', stderr)).toBe(
            'The credential plugin "aws" failed: Error loading SSO Token: Token for my-sso does not exist',
        );
        const long = describeExecFailure('kubelogin', new Error('x'.repeat(400)));
        expect(long.endsWith('…')).toBe(true);
        expect(long.length).toBeLessThan(260);
    });

    it('says so when the plugin left no message', () => {
        expect(describeExecFailure('aws', new Error(''))).toBe('The credential plugin "aws" failed without a message.');
        expect(describeExecFailure('aws', undefined)).toContain('without a message');
    });
});

describe('execCommandOf', () => {
    it('reads the command from either kubeconfig shape and nothing else', () => {
        expect(execCommandOf({ name: 'u', exec: { command: 'aws' } } as never)).toBe('aws');
        expect(
            execCommandOf({ name: 'u', authProvider: { name: 'exec', config: { exec: { command: 'gke' } } } } as never),
        ).toBe('gke');
        expect(execCommandOf({ name: 'u', token: 't' } as never)).toBeNull();
        expect(execCommandOf({ name: 'u', exec: {} } as never)).toBeNull();
        expect(execCommandOf(null)).toBeNull();
    });
});

describe('guardCredentialPlugins', () => {
    /** A stand-in for the library's per-config authenticator list, scripted per test. */
    function fakeConfig(apply: Authenticator['applyAuthentication']) {
        const auth: Authenticator = { isAuthProvider: () => true, applyAuthentication: apply };
        const kc = { authenticators: [auth] } as unknown as KubeConfig;
        guardCredentialPlugins(kc);
        return auth;
    }

    it('wraps a failing exec authenticator into an ExecPluginError with the command', async () => {
        const spawnFailure = Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' });
        const auth = fakeConfig(() => Promise.reject(spawnFailure));
        const attempt = auth.applyAuthentication(
            { name: 'u', exec: { command: 'aws', args: ['eks', 'get-token'] } },
            {},
        );
        await expect(attempt).rejects.toBeInstanceOf(ExecPluginError);
        await expect(attempt).rejects.toMatchObject({
            command: 'aws',
            code: 'EXEC_PLUGIN',
            detail: expect.stringContaining('not found'),
            cause: spawnFailure,
        });
    });

    it('lets failures of users without a plugin through untouched', async () => {
        const original = new Error('token file missing');
        const auth = fakeConfig(() => Promise.reject(original));
        await expect(auth.applyAuthentication({ name: 'u', token: 't' }, {})).rejects.toBe(original);
    });

    it('passes successful authentication through with the original arguments', async () => {
        const apply = vi.fn(() => Promise.resolve());
        const auth = fakeConfig(apply);
        const user = { name: 'u', exec: { command: 'aws' } };
        await expect(auth.applyAuthentication(user, { headers: {} })).resolves.toBeUndefined();
        expect(apply).toHaveBeenCalledWith(user, { headers: {} });
    });

    it('guards a real config once: every authenticator is wrapped, and a second call changes nothing', () => {
        const kc = new KubeConfig();
        kc.loadFromFile(FIXTURE);
        const before = authenticatorsOf(kc).map((a) => a.applyAuthentication);
        guardCredentialPlugins(kc);
        const wrapped = authenticatorsOf(kc).map((a) => a.applyAuthentication);
        expect(wrapped.length).toBe(before.length);
        wrapped.forEach((fn, i) => expect(fn).not.toBe(before[i]));
        guardCredentialPlugins(kc);
        expect(authenticatorsOf(kc).map((a) => a.applyAuthentication)).toEqual(wrapped);
    });

    it('tolerates a config without an authenticator list', () => {
        expect(() => guardCredentialPlugins({} as KubeConfig)).not.toThrow();
    });
});

describe('a credential plugin under a ceiling', () => {
    /** The library's own spawn seam, scripted: an emitter with the one method the guard calls. */
    function fakeChild() {
        const child = new EventEmitter() as EventEmitter & ChildProcess;
        child.kill = vi.fn(() => true) as ChildProcess['kill'];
        return child;
    }

    function guardedSpawner(child: ChildProcess) {
        const spawn = vi.fn(() => child);
        const auth: Authenticator = {
            isAuthProvider: () => true,
            applyAuthentication: () => Promise.resolve(),
            execFn: spawn,
        };
        guardCredentialPlugins({ authenticators: [auth] } as unknown as KubeConfig);
        return { auth, spawn };
    }

    it('kills the process when the call that spawned it gives up', async () => {
        const child = fakeChild();
        const { auth } = guardedSpawner(child);
        const controller = new AbortController();
        await withAbortScope(controller.signal, async () => {
            expect(auth.execFn?.('aws', ['eks', 'get-token'], { env: {} })).toBe(child);
        });
        expect(child.kill).not.toHaveBeenCalled();
        controller.abort();
        expect(child.kill).toHaveBeenCalled();
    });

    it('kills it at once when the ceiling has already fired', () => {
        const child = fakeChild();
        const { auth } = guardedSpawner(child);
        const controller = new AbortController();
        controller.abort();
        void withAbortScope(controller.signal, async () => {
            auth.execFn?.('aws');
        });
        expect(child.kill).toHaveBeenCalled();
    });

    it('leaves a plugin spawned outside any ceiling running', () => {
        const child = fakeChild();
        const { auth } = guardedSpawner(child);
        expect(auth.execFn?.('aws')).toBe(child);
        expect(child.kill).not.toHaveBeenCalled();
    });

    it('stops listening once the plugin has answered, so a later ceiling kills nothing', async () => {
        const child = fakeChild();
        const { auth } = guardedSpawner(child);
        const controller = new AbortController();
        await withAbortScope(controller.signal, async () => {
            auth.execFn?.('aws');
        });
        child.emit('close', 0);
        controller.abort();
        expect(child.kill).not.toHaveBeenCalled();
    });

    it('spawns exactly what the library asked for', () => {
        const child = fakeChild();
        const { auth, spawn } = guardedSpawner(child);
        const options = { env: { AWS_PROFILE: 'prod' } };
        auth.execFn?.('gke-gcloud-auth-plugin', ['--use_application_default_credentials'], options);
        expect(spawn).toHaveBeenCalledWith(
            'gke-gcloud-auth-plugin',
            ['--use_application_default_credentials'],
            options,
        );
    });

    it('leaves an authenticator that spawns nothing alone', () => {
        const plain: Authenticator = { isAuthProvider: () => false, applyAuthentication: () => Promise.resolve() };
        guardCredentialPlugins({ authenticators: [plain] } as unknown as KubeConfig);
        expect(plain.execFn).toBeUndefined();
    });
});
