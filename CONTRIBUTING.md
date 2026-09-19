# Contributing

Thanks for taking the time. This guide covers how the project is set up, what a change has to pass,
and how it lands. Everything here applies to every contributor, the maintainer included.

## Before you start

- **Bugs and small fixes**: open an issue or go straight to a pull request.
- **New features or behaviour changes**: open an issue first and describe what you want to change
  and why. The app is deliberately opinionated about what it does and does not do (it never runs
  anything inside the cluster, never writes the kubeconfig, never acts on a cluster other than the
  one on screen), and a short conversation up front saves work on both sides.
- **Security problems**: follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Setup

You need Node.js 24 and npm 11.19 or newer. Older npm versions silently drop optional lockfile
entries and break `npm ci`.

```sh
git clone https://github.com/kubermeister/kubermeister.git
cd kubermeister
npm install
git config core.hooksPath .githooks   # once per clone: checks commit messages
npm run dev                            # Electron with hot reload
```

`npm install` also downloads the Electron binary through a `postinstall` script. If you installed
with `--ignore-scripts`, run `node node_modules/electron/install.js` by hand.

## The gates

Run all four after every change. CI runs the same set on every pull request, plus the end-to-end
suite, and every check has to be green before a merge.

```sh
npm run lint
npm run typecheck
npm run format
npm run test
```

ESLint does not type-check and Prettier covers the whole repository including Markdown and JSON, so
none of the four replaces another.

## Tests

Tests come first: a change is specified by its tests before it is wired in, and every pull request
that changes behaviour ships with them, error paths included.

- **Unit and component tests** run with Vitest. `tests/unit/` mirrors `src/`, so
  `tests/unit/main/updater.test.ts` tests `src/main/updater.ts`. Main-process modules mock `electron`
  and the Kubernetes client at the module boundary; renderer components use Testing Library under
  jsdom. Run one file with `npx vitest run tests/unit/main/updater.test.ts`, or `npm run test:watch`.
- **Coverage** thresholds in `vitest.config.ts` fail CI when missed and only ever go up. Check with
  `npm run test:coverage`.
- **End-to-end tests** run with Playwright against the built app and a disposable k3s cluster that
  Testcontainers starts in Docker. Run `npm run build` first, then `npm run test:e2e`.
  `KM_E2E_KEEP_CLUSTER=1` keeps the container between runs.

No test ever touches a real cluster or your kubeconfig. The end-to-end harness writes a kubeconfig
for its own container only and aborts the whole suite if the active context is anything else. Keep
it that way: a test that needs a cluster uses the harness.

## Architecture

[CLAUDE.md](CLAUDE.md) holds the architecture rules the codebase is built on: the process boundary,
the IPC contract, the design-system templates, how a new kind is added, the write path, streams,
and the release model. Read the section that covers the area you are changing before you change it.
The rules there are load-bearing, and a pull request that works around one will be asked to follow
it instead.

Code style is decided by Prettier and EditorConfig. Beyond that: readability over cleverness,
comments only for _why_, and no `any` in TypeScript.

## Branches, commits and pull requests

- Never commit on `main`. Branch as `type/short-slug` (kebab-case, two to four words, no issue
  numbers), for example `fix/log-filter-regex`.
- Every change lands as a **squash-merged pull request**. The PR title becomes the commit header on
  `main` and the PR body becomes its body, so both follow the commit format below.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): subject`. Types are `feat` `fix` `perf` `refactor` `docs` `test` `chore` `ci`
  `build` `style` `revert`. Scopes are `repo` `main` `preload` `renderer` `shared` `ipc` `k8s`
  `build` `ci` `deps` `docs` `release`. The subject is lowercase, imperative, without a trailing
  period, and the whole header is 72 characters or fewer. The commit hook checks this.
- Keep PR titles at 66 characters or fewer; GitHub appends the PR number.
- Write each paragraph of the PR body as one unwrapped line. Say why the change is needed and what a
  reader of the history could not learn from the diff.
- No trailers: no `Co-Authored-By`, no `Signed-off-by`.
- Mark a breaking change with `!` after the scope: `feat(ipc)!: rename stream channels`.

A pull request is reviewed once its checks pass. Reviews are about the change, not the person, and
questions in a review are questions, not verdicts.

## Releases

Releases are cut by the maintainer: a `vX.Y.Z` tag ships a release once its `chore(release): X.Y.Z`
PR has merged, and releases are frequent, so a merged fix reaches users quickly. Release notes
are generated from the merged pull request titles, which is one more reason the title has to read
well on its own.
