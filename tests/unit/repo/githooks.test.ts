import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const preCommit = resolve('.githooks/pre-commit');
const enableHooks = resolve('scripts/enable-hooks.mjs');
let repo = '';

function git(...args: string[]): string {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

function commit(message: string): void {
    writeFileSync(join(repo, `${message}.txt`), message);
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message);
}

function runPreCommit(): { status: number | null; stderr: string } {
    const result = spawnSync('sh', [preCommit], { cwd: repo, encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr };
}

function runEnableHooks(cwd = repo): { status: number | null; stderr: string } {
    const result = spawnSync(process.execPath, [enableHooks], { cwd, encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr };
}

describe('git hooks', () => {
    beforeEach(() => {
        repo = mkdtempSync(join(tmpdir(), 'km-hooks-'));
        git('init', '-q', '-b', 'main');
    });

    afterEach(() => {
        rmSync(repo, { recursive: true, force: true });
    });

    describe('pre-commit', () => {
        it('refuses a commit on main and says how to move to a branch', () => {
            const { status, stderr } = runPreCommit();
            expect(status).toBe(1);
            expect(stderr).toContain('refusing to commit on main');
            expect(stderr).toContain('git switch -c type/short-slug');
        });

        it('allows a commit on any other branch', () => {
            git('switch', '-q', '-c', 'feat/anything');
            expect(runPreCommit()).toEqual({ status: 0, stderr: '' });
        });

        it('stays out of the way on a detached head', () => {
            commit('first');
            git('checkout', '-q', '--detach');
            expect(runPreCommit()).toEqual({ status: 0, stderr: '' });
        });
    });

    describe('enable-hooks', () => {
        it('points a fresh clone at the repository hooks', () => {
            expect(runEnableHooks().status).toBe(0);
            expect(git('config', '--get', 'core.hooksPath')).toBe('.githooks');
        });

        it('leaves a hooks path the developer chose and says where the repository hooks are', () => {
            git('config', 'core.hooksPath', '.husky');
            const { status, stderr } = runEnableHooks();
            expect(status).toBe(0);
            expect(stderr).toContain('.husky');
            expect(stderr).toContain('.githooks');
            expect(git('config', '--get', 'core.hooksPath')).toBe('.husky');
        });

        it('does nothing outside a git checkout', () => {
            const plain = mkdtempSync(join(tmpdir(), 'km-plain-'));
            try {
                expect(runEnableHooks(plain)).toEqual({ status: 0, stderr: '' });
            } finally {
                rmSync(plain, { recursive: true, force: true });
            }
        });
    });
});

/**
 * The scope list is written out three times: for the developer's commit (`.githooks/commit-msg`),
 * for the PR title the squash commit on `main` takes (`.github/workflows/pr-title.yml`), and for
 * the reader (AGENTS.md). Nothing makes them one list, so this is what makes them agree — a scope
 * added to the hook alone passes locally and then fails the title check on a PR that is otherwise
 * ready.
 */
describe('the commit scopes', () => {
    const read = (path: string) => readFileSync(resolve(path), 'utf8');

    function hookScopes(): string[] {
        const line = /^scopes='([^']+)'/m.exec(read('.githooks/commit-msg'));
        if (!line) throw new Error('.githooks/commit-msg declares no scopes');
        return line[1].split('|');
    }

    function workflowScopes(): string[] {
        const block = /\n {10}scopes: \|\n((?: {12}\S+\n)+)/.exec(read('.github/workflows/pr-title.yml'));
        if (!block) throw new Error('pr-title.yml declares no scopes');
        return block[1].trim().split(/\s+/);
    }

    function documentedScopes(): string[] {
        // The bullet wraps over several lines and ends at the sentence that follows the list.
        const bullet = /- \*\*scope\*\* \(required\): ([\s\S]*?)\. /.exec(read('AGENTS.md'));
        if (!bullet) throw new Error('AGENTS.md documents no scopes');
        return [...bullet[1].matchAll(/`([a-z0-9]+)`/g)].map((match) => match[1]);
    }

    it('are the same list in the hook, the PR title check and AGENTS.md', () => {
        const hook = hookScopes();
        expect(hook.length).toBeGreaterThan(1);
        expect(workflowScopes()).toEqual(hook);
        expect(documentedScopes()).toEqual(hook);
    });
});
