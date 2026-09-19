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

### Issues

One problem or one request per issue. The bug and feature forms ask for what a maintainer needs to
act; a blank issue is fine when neither fits. Issues are the whole plan: there is no board and no
separate roadmap, so what the open issues and milestones say is what is going to happen.

- **Type** (Bug, Feature, Task) says what an issue is; the forms set it.
- **Milestones** are the next minor versions: a milestone holds what its version ships, and the
  version is cut when the milestone is empty. Patch releases carry no milestone.
- **Labels** come in groups, all defined in [`.github/labels.yml`](.github/labels.yml): one
  `area:` per issue, a `priority:` and a `size:` set at triage (a size is an estimate, not a
  promise), and a status word. `needs-triage` means nobody has looked yet, `needs-info` means the
  reporter is being asked for something (the only state that ever goes stale), `blocked` names a
  dependency, and `ready` means the issue is scoped and anyone may start. Being worked on is an
  assignee plus a linked pull request, not a label.
- **Where to start**: [`ready`](https://github.com/kubermeister/kubermeister/issues?q=is%3Aissue%20is%3Aopen%20label%3Aready)
  and [`good first issue`](https://github.com/kubermeister/kubermeister/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22).
  Say so on the issue before starting, so two people do not build the same thing.
- **Linking**: a pull request that resolves an issue ends its body with one line, `Closes #N.`,
  which closes the issue on merge and puts its number in the commit history.

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
- No trailers: no `Co-Authored-By`, no `Signed-off-by`. `Closes #N.` as the last paragraph is a
  sentence, not a trailer, and is how a pull request names the issue it resolves.
- Mark a breaking change with `!` after the scope: `feat(ipc)!: rename stream channels`.

A pull request is reviewed once its checks pass. Reviews are about the change, not the person, and
questions in a review are questions, not verdicts.

## Releases

Releases are cut by the maintainer: a `vX.Y.Z` tag ships a release once its `chore(release): X.Y.Z`
PR has merged, and releases are frequent, so a merged fix reaches users quickly. Release notes
are generated from the merged pull request titles, sorted into sections by the label the title's
type earns (`feat` under Features, `fix` under Fixes, and so on), which is one more reason the title
has to read well on its own.
