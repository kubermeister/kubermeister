import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    HELM_OUTPUT_LIMIT_BYTES,
    findHelm,
    findOnPath,
    helmStatus,
    isolatedHelmEnv,
    parseHelmVersion,
    resetHelmLookup,
    runHelm,
    withHelmHome,
} from '../../../src/main/charts/helm-cli';

class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    kill = vi.fn();
}

type Script = (child: FakeChild, args: string[]) => void;

function fakeSpawn(script: Script) {
    const spawn = vi.fn((_command: string, args: string[], _options: unknown) => {
        const child = new FakeChild();
        queueMicrotask(() => script(child, args));
        return child as never;
    });
    return spawn as unknown as typeof import('node:child_process').spawn & typeof spawn;
}

const prints =
    (stdout: string, code = 0, stderr = ''): Script =>
    (child) => {
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        child.emit('close', code);
    };

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'km-helm-cli-'));
    resetHelmLookup();
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function executable(at: string): string {
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, '#!/bin/sh\n');
    chmodSync(at, 0o755);
    return at;
}

describe('parseHelmVersion', () => {
    it('reads what `helm version --short` prints for Helm 3 and 4', () => {
        expect(parseHelmVersion('v3.14.2+gc309b6f\n')).toBe('3.14.2');
        expect(parseHelmVersion('v4.2.4+g3900f43')).toBe('4.2.4');
        expect(parseHelmVersion('v3.0.0-rc.1+g1234567')).toBe('3.0.0-rc.1');
        expect(parseHelmVersion('\n  v3.9.0\n')).toBe('3.9.0');
    });

    it('counts Helm 2 and anything unparseable as not found', () => {
        expect(parseHelmVersion('Client: v2.16.1+gbbdfe5e')).toBeNull();
        expect(parseHelmVersion('v2.17.0')).toBeNull();
        expect(parseHelmVersion('')).toBeNull();
        expect(parseHelmVersion('helm: command not found')).toBeNull();
        expect(parseHelmVersion('v3.14')).toBeNull();
    });
});

describe('findOnPath', () => {
    it('answers the first executable named helm along PATH, in order', () => {
        executable(path.join(dir, 'b', 'helm'));
        executable(path.join(dir, 'c', 'helm'));
        const env = { PATH: [path.join(dir, 'a'), path.join(dir, 'b'), path.join(dir, 'c')].join(':') };
        expect(findOnPath('helm', env, 'darwin')).toBe(path.join(dir, 'b', 'helm'));
    });

    it('skips a file that is not executable, a directory and a relative PATH entry', () => {
        mkdirSync(path.join(dir, 'plain'));
        writeFileSync(path.join(dir, 'plain', 'helm'), '');
        chmodSync(path.join(dir, 'plain', 'helm'), 0o644);
        mkdirSync(path.join(dir, 'folder', 'helm'), { recursive: true });
        const env = { PATH: ['bin', path.join(dir, 'plain'), path.join(dir, 'folder')].join(':') };
        expect(findOnPath('helm', env, 'linux')).toBeNull();
        expect(findOnPath('helm', {}, 'linux')).toBeNull();
    });

    it('looks for helm.exe on Windows, reading Path whatever its case', () => {
        executable(path.join(dir, 'win', 'helm.exe'));
        executable(path.join(dir, 'shim', 'helm.cmd'));
        const env = { Path: `${path.join(dir, 'shim')};${path.join(dir, 'win')}` };
        expect(findOnPath('helm', env, 'win32')).toBe(path.join(dir, 'win', 'helm.exe'));
    });
});

describe('isolatedHelmEnv', () => {
    it('points Helm at the throwaway home and passes nothing from the app environment', () => {
        const env = isolatedHelmEnv('/scratch', 'darwin', {
            PATH: '/opt/homebrew/bin',
            KUBECONFIG: '/Users/me/.kube/config',
            HELM_KUBECONTEXT: 'prod',
            HELM_REPOSITORY_CONFIG: '/Users/me/repos.yaml',
            HTTPS_PROXY: 'http://proxy:3128',
        });
        expect(env).toEqual({
            HOME: '/scratch',
            TMPDIR: '/scratch',
            KUBECONFIG: path.join('/scratch', 'kubeconfig'),
            HELM_CACHE_HOME: path.join('/scratch', 'cache'),
            HELM_CONFIG_HOME: path.join('/scratch', 'config'),
            HELM_DATA_HOME: path.join('/scratch', 'data'),
            HELM_PLUGINS: path.join('/scratch', 'plugins'),
        });
    });

    it('keeps SystemRoot on Windows, which a Go binary needs to start', () => {
        const env = isolatedHelmEnv('C:\\scratch', 'win32', {
            SystemRoot: 'C:\\Windows',
            USERPROFILE: 'C:\\Users\\me',
        });
        expect(env).toMatchObject({ SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\scratch', TEMP: 'C:\\scratch' });
        expect(env.KUBECONFIG).toBe(path.join('C:\\scratch', 'kubeconfig'));
    });
});

describe('withHelmHome', () => {
    it('hands over a private directory holding an empty kubeconfig and removes it afterwards', async () => {
        let seen = '';
        await withHelmHome(async (home) => {
            seen = home;
            const { readFileSync, statSync } = await import('node:fs');
            expect(readFileSync(path.join(home, 'kubeconfig'), 'utf8')).toBe('');
            expect(statSync(path.join(home, 'kubeconfig')).mode & 0o077).toBe(0);
        });
        const { existsSync } = await import('node:fs');
        expect(existsSync(seen)).toBe(false);
    });

    it('removes the directory when the work throws', async () => {
        let seen = '';
        await expect(
            withHelmHome((home) => {
                seen = home;
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        const { existsSync } = await import('node:fs');
        expect(existsSync(seen)).toBe(false);
    });
});

describe('runHelm', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs the binary with the arguments and environment given, collecting both outputs', async () => {
        const spawn = fakeSpawn(prints('out', 1, 'err'));
        const result = runHelm('/bin/helm', ['version'], { env: { HOME: '/h' }, cwd: '/h', spawn });
        await vi.advanceTimersByTimeAsync(0);
        await expect(result).resolves.toEqual({ ok: true, code: 1, stdout: 'out', stderr: 'err' });
        const [command, args, options] = spawn.mock.calls[0] ?? [];
        expect(command).toBe('/bin/helm');
        expect(args).toEqual(['version']);
        expect(options).toMatchObject({ env: { HOME: '/h' }, cwd: '/h', stdio: ['ignore', 'pipe', 'pipe'] });
    });

    it('kills a child that runs past the timeout', async () => {
        const spawn = fakeSpawn(() => undefined);
        const result = runHelm('/bin/helm', [], { env: {}, cwd: '/', spawn, timeoutMs: 1000 });
        const child = spawn.mock.results[0]?.value as FakeChild;
        await vi.advanceTimersByTimeAsync(1000);
        await expect(result).resolves.toEqual({ ok: false, failure: 'timeout' });
        expect(child.kill).toHaveBeenCalled();
    });

    it('kills a child whose output grows past the cap', async () => {
        const spawn = fakeSpawn((child) => child.stdout.emit('data', Buffer.alloc(11)));
        const result = runHelm('/bin/helm', [], { env: {}, cwd: '/', spawn, maxOutputBytes: 10 });
        await vi.advanceTimersByTimeAsync(0);
        await expect(result).resolves.toEqual({ ok: false, failure: 'tooLarge' });
        expect((spawn.mock.results[0]?.value as FakeChild).kill).toHaveBeenCalled();
        expect(HELM_OUTPUT_LIMIT_BYTES).toBeGreaterThan(1024 * 1024);
    });

    it('reports a binary that cannot be started', async () => {
        const spawn = fakeSpawn((child) => child.emit('error', new Error('spawn helm EACCES')));
        const result = runHelm('/bin/helm', [], { env: {}, cwd: '/', spawn });
        await vi.advanceTimersByTimeAsync(0);
        await expect(result).resolves.toEqual({ ok: false, failure: 'spawn', message: 'spawn helm EACCES' });
    });

    it('reports a spawn that throws outright', async () => {
        const spawn = vi.fn(() => {
            throw new Error('ENOENT');
        }) as unknown as typeof import('node:child_process').spawn;
        await expect(runHelm('/bin/helm', [], { env: {}, cwd: '/', spawn })).resolves.toEqual({
            ok: false,
            failure: 'spawn',
            message: 'ENOENT',
        });
    });
});

describe('findHelm', () => {
    it('asks the helm found on PATH for its version, isolated like a render', async () => {
        const helm = executable(path.join(dir, 'bin', 'helm'));
        const spawn = fakeSpawn(prints('v3.15.1+gdeadbee\n'));
        const found = await findHelm({ env: { PATH: path.dirname(helm) }, platform: 'darwin', spawn });
        expect(found).toEqual({ path: helm, version: '3.15.1' });
        const [command, args, options] = spawn.mock.calls[0] ?? [];
        expect(command).toBe(helm);
        expect(args).toEqual(['version', '--short']);
        const env = (options as { env: NodeJS.ProcessEnv }).env;
        expect(env.KUBECONFIG).toMatch(/kubeconfig$/);
        expect(env.PATH).toBeUndefined();
    });

    it('is null when nothing is on PATH, without running anything', async () => {
        const spawn = fakeSpawn(prints('v3.15.1'));
        await expect(
            findHelm({ env: { PATH: path.join(dir, 'none') }, platform: 'darwin', spawn }),
        ).resolves.toBeNull();
        expect(spawn).not.toHaveBeenCalled();
    });

    it('is null for Helm 2, a failing binary and one that cannot start', async () => {
        executable(path.join(dir, 'bin', 'helm'));
        const env = { PATH: path.join(dir, 'bin') };
        await expect(
            findHelm({ env, platform: 'darwin', spawn: fakeSpawn(prints('Client: v2.16.1')) }),
        ).resolves.toBeNull();
        resetHelmLookup();
        await expect(findHelm({ env, platform: 'darwin', spawn: fakeSpawn(prints('v3.1.0', 1)) })).resolves.toBeNull();
        resetHelmLookup();
        const broken = fakeSpawn((child) => child.emit('error', new Error('bad CPU type')));
        await expect(findHelm({ env, platform: 'darwin', spawn: broken })).resolves.toBeNull();
    });

    it('asks a binary once and asks again when it is replaced', async () => {
        const helm = executable(path.join(dir, 'bin', 'helm'));
        const env = { PATH: path.dirname(helm) };
        const spawn = fakeSpawn(prints('v3.15.1'));
        await findHelm({ env, platform: 'darwin', spawn });
        await findHelm({ env, platform: 'darwin', spawn });
        expect(spawn).toHaveBeenCalledTimes(1);
        writeFileSync(helm, '#!/bin/sh\n# upgraded\n');
        await findHelm({ env, platform: 'darwin', spawn });
        expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('does not remember a missing helm, so one installed while the app runs is found', async () => {
        const env = { PATH: path.join(dir, 'bin') };
        const spawn = fakeSpawn(prints('v3.15.1'));
        await expect(findHelm({ env, platform: 'darwin', spawn })).resolves.toBeNull();
        executable(path.join(dir, 'bin', 'helm'));
        await expect(findHelm({ env, platform: 'darwin', spawn })).resolves.toMatchObject({ version: '3.15.1' });
    });
});

describe('helmStatus', () => {
    it('reports where Helm was found and at which version', async () => {
        const helm = executable(path.join(dir, 'bin', 'helm'));
        const spawn = fakeSpawn(prints('v4.0.0'));
        await expect(helmStatus({ env: { PATH: path.dirname(helm) }, platform: 'darwin', spawn })).resolves.toEqual({
            found: true,
            path: helm,
            version: '4.0.0',
        });
    });

    it('reports a missing Helm as a state, not a failure', async () => {
        await expect(helmStatus({ env: {}, platform: 'darwin' })).resolves.toEqual({ found: false });
    });
});
