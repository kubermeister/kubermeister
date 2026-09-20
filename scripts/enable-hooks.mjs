// Points git at the repository's hooks so a fresh clone validates commit headers and refuses commits
// on main without a once-per-clone step. Runs from `postinstall`, so it must never fail an install:
// outside a git checkout (a tarball, a CI image without .git) or without git there is nothing to do,
// and a hooks path the developer chose themselves is left alone rather than overwritten.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const HOOKS_PATH = '.githooks';

// A worktree's .git is a file, which is why this is not a directory check.
if (!existsSync('.git')) process.exit(0);

const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
if (current.error) process.exit(0);

const configured = current.stdout.trim();
if (configured === HOOKS_PATH) process.exit(0);
if (configured !== '') {
    console.warn(
        `enable-hooks: core.hooksPath is ${configured}; leaving it. The repository's hooks live in ${HOOKS_PATH}.`,
    );
    process.exit(0);
}

spawnSync('git', ['config', 'core.hooksPath', HOOKS_PATH], { stdio: 'ignore' });
