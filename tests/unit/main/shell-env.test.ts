import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    SHELL_ENV_TIMEOUT_MS,
    SHELL_ENV_VARS,
    adoptLoginShellEnv,
    extractEnv,
    loginShellEnv,
    mergePath,
} from '../../../src/main/shell-env';

class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    kill = vi.fn();
}

/** A spawn stub that scripts what the shell prints and how it exits. */
function fakeSpawn(script: (child: FakeChild) => void) {
    const spawn = vi.fn((_shell: string, _args: string[], _opts: unknown) => {
        const child = new FakeChild();
        queueMicrotask(() => script(child));
        return child as never;
    });
    return spawn as unknown as typeof import('node:child_process').spawn & typeof spawn;
}

/** What the shell prints for a set of variables: the values, marker-separated, in the asked order. */
function printed(values: Partial<Record<(typeof SHELL_ENV_VARS)[number], string>>): string {
    return `__KM_ENV__${SHELL_ENV_VARS.map((name) => values[name] ?? '').join('__KM_ENV__')}__KM_ENV__`;
}

const printEnv = (values: Partial<Record<(typeof SHELL_ENV_VARS)[number], string>>) => (child: FakeChild) => {
    child.stdout.emit('data', `Last login: banner\n${printed(values)}`);
    child.emit('close', 0);
};

describe('mergePath', () => {
    it('puts the shell entries first and keeps inherited ones the shell lacks, without duplicates', () => {
        expect(mergePath('/usr/bin:/bin:/extra', '/opt/homebrew/bin:/usr/bin:/bin')).toBe(
            '/opt/homebrew/bin:/usr/bin:/bin:/extra',
        );
        expect(mergePath(undefined, '/a::/b:/a')).toBe('/a:/b');
    });
});

describe('extractEnv', () => {
    it('finds the values between the markers whatever the profile printed around them', () => {
        const output = `motd\n${printed({ PATH: '/a:/b', HTTPS_PROXY: 'http://proxy:3128' })}\nbye`;
        expect(extractEnv(output)).toEqual({ PATH: '/a:/b', HTTPS_PROXY: 'http://proxy:3128' });
    });

    it('is null when the markers are missing or the shell printed the wrong number of values', () => {
        expect(extractEnv('no markers')).toBeNull();
        expect(extractEnv('__KM_ENV__/a')).toBeNull();
        expect(extractEnv('__KM_ENV__/a__KM_ENV__/b__KM_ENV__')).toBeNull();
    });

    it('drops the variables the shell has nothing for', () => {
        expect(extractEnv(printed({}))).toEqual({});
        expect(extractEnv(printed({ NO_PROXY: '.corp.example' }))).toEqual({ NO_PROXY: '.corp.example' });
    });
});

describe('loginShellEnv', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('asks the login shell from $SHELL, interactively, for the PATH and the proxy variables', async () => {
        const spawn = fakeSpawn(printEnv({ PATH: '/opt/homebrew/bin:/usr/bin', HTTPS_PROXY: 'http://proxy:3128' }));
        const env = { SHELL: '/bin/fish', PATH: '/usr/bin' };
        const result = loginShellEnv({ platform: 'darwin', env, spawn });
        await vi.advanceTimersByTimeAsync(0);
        await expect(result).resolves.toEqual({ PATH: '/opt/homebrew/bin:/usr/bin', HTTPS_PROXY: 'http://proxy:3128' });
        const [shell, args, options] = spawn.mock.calls[0] ?? [];
        expect(shell).toBe('/bin/fish');
        expect(args?.[0]).toBe('-ilc');
        for (const name of SHELL_ENV_VARS) expect(args?.[1]).toContain(`"$${name}"`);
        expect(options).toMatchObject({ env, stdio: ['ignore', 'pipe', 'ignore'] });
    });

    it('defaults to zsh on macOS and bash elsewhere when $SHELL is unset', async () => {
        for (const [platform, shell] of [
            ['darwin', '/bin/zsh'],
            ['linux', '/bin/bash'],
        ] as const) {
            const spawn = fakeSpawn(printEnv({ PATH: '/x' }));
            const result = loginShellEnv({ platform, env: {}, spawn });
            await vi.advanceTimersByTimeAsync(0);
            await expect(result).resolves.toEqual({ PATH: '/x' });
            expect(spawn.mock.calls[0]?.[0]).toBe(shell);
        }
    });

    it('is null on Windows without spawning anything', async () => {
        const spawn = fakeSpawn(() => {});
        await expect(loginShellEnv({ platform: 'win32', env: {}, spawn })).resolves.toBeNull();
        expect(spawn).not.toHaveBeenCalled();
    });

    it('is null when the shell fails to start, exits without markers, or cannot be spawned', async () => {
        const failing = fakeSpawn((child) => child.emit('error', new Error('ENOENT')));
        const failed = loginShellEnv({ platform: 'linux', env: {}, spawn: failing });
        await vi.advanceTimersByTimeAsync(0);
        await expect(failed).resolves.toBeNull();

        const silent = fakeSpawn((child) => child.emit('close', 1));
        const quiet = loginShellEnv({ platform: 'linux', env: {}, spawn: silent });
        await vi.advanceTimersByTimeAsync(0);
        await expect(quiet).resolves.toBeNull();

        const throwing = vi.fn(() => {
            throw new Error('EACCES');
        }) as unknown as typeof import('node:child_process').spawn;
        await expect(loginShellEnv({ platform: 'linux', env: {}, spawn: throwing })).resolves.toBeNull();
    });

    it('gives up on a hanging shell after the timeout and kills it', async () => {
        let child: FakeChild | undefined;
        const spawn = fakeSpawn((c) => {
            child = c;
        });
        const result = loginShellEnv({ platform: 'linux', env: {}, spawn });
        await vi.advanceTimersByTimeAsync(SHELL_ENV_TIMEOUT_MS);
        await expect(result).resolves.toBeNull();
        expect(child?.kill).toHaveBeenCalledOnce();
        // A late answer after the timeout changes nothing.
        child?.stdout.emit('data', printed({ PATH: '/late' }));
        child?.emit('close', 0);
        await expect(result).resolves.toBeNull();
    });
});

describe('adoptLoginShellEnv', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('replaces the process PATH with the merged one and reports what it took', async () => {
        const env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' };
        const spawn = fakeSpawn(printEnv({ PATH: '/opt/homebrew/bin:/usr/bin' }));
        const result = adoptLoginShellEnv({ platform: 'darwin', env, spawn });
        await vi.advanceTimersByTimeAsync(0);
        await expect(result).resolves.toEqual(['PATH']);
        expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    });

    it('takes the proxy the profile sets, so a Finder launch reaches the cluster the way a shell does', async () => {
        const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
        const spawn = fakeSpawn(
            printEnv({ PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy:3128', no_proxy: '.corp.example' }),
        );
        const result = adoptLoginShellEnv({ platform: 'linux', env, spawn });
        await vi.advanceTimersByTimeAsync(0);
        await expect(result).resolves.toEqual(['HTTPS_PROXY', 'no_proxy']);
        expect(env.HTTPS_PROXY).toBe('http://proxy:3128');
        expect(env.no_proxy).toBe('.corp.example');
    });

    it('never overwrites a variable the launch environment already carries', async () => {
        const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', HTTPS_PROXY: 'http://launched-with:3128' };
        const spawn = fakeSpawn(printEnv({ PATH: '/usr/bin', HTTPS_PROXY: 'http://from-profile:3128' }));
        const result = adoptLoginShellEnv({ platform: 'linux', env, spawn });
        await vi.advanceTimersByTimeAsync(0);
        await expect(result).resolves.toEqual([]);
        expect(env.HTTPS_PROXY).toBe('http://launched-with:3128');
    });

    it('leaves the environment alone when nothing was learned or nothing would change', async () => {
        const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
        const same = adoptLoginShellEnv({
            platform: 'linux',
            env,
            spawn: fakeSpawn(printEnv({ PATH: '/usr/bin:/bin' })),
        });
        await vi.advanceTimersByTimeAsync(0);
        await expect(same).resolves.toEqual([]);
        expect(env.PATH).toBe('/usr/bin:/bin');
        await expect(adoptLoginShellEnv({ platform: 'win32', env })).resolves.toEqual([]);
        expect(env.PATH).toBe('/usr/bin:/bin');
    });
});
