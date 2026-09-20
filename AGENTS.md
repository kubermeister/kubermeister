# Kubermeister

Desktop Kubernetes client (Electron).

This file is the project's agent instructions. `CLAUDE.md` only imports it, so edits go here.

## Commands

- `npm run dev` starts Electron with Vite HMR. `npm run build` writes `out/`.
- Node 24 and npm 11.19 or newer are required (`engines` + `engine-strict`). CI runs the same
  versions; older npm silently drops optional lockfile entries and breaks `npm ci`.
- Since Electron 42 the npm package no longer downloads its binary on install; the `postinstall`
  script runs Electron's installer so `node_modules/electron/dist` exists for electron-vite dev
  and for the license notices packaging copies, then enables the git hooks. After an install with
  `--ignore-scripts`, run `node node_modules/electron/install.js` by hand.
- `npm run package` builds the current OS's installers into `release/` (`package:dir` for a fast
  unpacked bundle). The artifact name pattern in `electron-builder.yml` is load-bearing for the
  release workflows; change both together.
- After every change run `npm run lint`, `npm run typecheck`, `npm run format`, and `npm run test`.
  ESLint does not type-check, and Prettier covers the whole repo including Markdown and JSON.

## Git workflow

- **Never commit on `main`.** Create a branch first: `type/short-slug` (kebab-case, 2 to 4 words,
  no issue numbers, no usernames). Example: `feat/ipc-bridge`. The `pre-commit` hook refuses a
  commit while HEAD is `main`.
- Every change lands as a **squash-merged PR**. The PR title is the resulting commit header on
  `main` and the PR body is its body, so both follow the commit rules below.
- Open PRs with `gh pr create`. Never merge; the user merges.
- The PR body becomes the commit body on `main` and GitHub re-wraps it at 72 columns: write each
  paragraph as one unwrapped line. GitHub appends ` (#N)` to the title: keep PR titles at 66
  characters or fewer.
- The hooks live in `.githooks` (`commit-msg`, `pre-commit`). `npm install` enables them through
  `scripts/enable-hooks.mjs` in `postinstall`, which sets `core.hooksPath` only when it is unset, so
  a path the developer chose is left alone. By hand: `git config core.hooksPath .githooks`. Hook
  and script tests live in `tests/unit/repo`.
- CI runs on pull requests against `main` only, so a PR stacked on another branch gets nothing but
  the title check until it is retargeted.
- Retarget every child to `main` before merging its parent, because GitHub closes a PR whose base
  branch is deleted and never reopens it. Push after retargeting, since a base change alone starts
  no checks.

### Issues are the plan

- There is no board and no other backlog: the open milestones (one per upcoming minor version) and
  their issues are what is going to happen. A session resumes from `gh issue list` filtered by
  milestone or by the `ready` label.
- A bug found in real use gets an issue before its fix.
- A PR that resolves an issue ends its body with the one-line paragraph `Closes #N.` (a sentence,
  not a trailer).
- File work with `gh issue create` giving `--type`, one `area:` label, a `size:` label and the
  milestone.
- The labels are defined in `.github/labels.yml` and change only through that file, which the
  `labels.yml` workflow syncs on merge.
- PR labels for the release notes come from the title's type (`pr-labels.yml`,
  `.github/release.yml`); never set them by hand.

### Commit messages (Conventional Commits 1.0)

```
type(scope): subject

Body: why the change is needed, what a reader of the history cannot learn from the diff.
```

- **type**: `feat` `fix` `perf` `refactor` `docs` `test` `chore` `ci` `build` `style` `revert`.
- **scope** (required): `repo` `main` `preload` `renderer` `shared` `ipc` `k8s` `build` `ci`
  `deps` `docs` `release`. A new area adds its scope here and in `.githooks/commit-msg` within
  the same change.
- **subject**: lowercase, imperative, no trailing period, whole header 72 characters or fewer.
  Proper nouns that need capitals go in the body.
- Breaking change: `!` after the scope, e.g. `feat(ipc)!: rename stream channels`.
- **No trailers.** No `Co-Authored-By`, no `Signed-off-by`, nothing after the body.

## Architecture rules (load-bearing)

### Processes and boundaries

- **Main is ESM** (`.mjs`), **preload is CJS** (`.cjs`, sandboxed preloads only run CommonJS).
- Node-side relative imports (`src/main`, `src/shared`) carry explicit `.js` extensions; renderer
  imports omit them.
- `src/shared` is compiled by both tsconfig projects, so it must not touch DOM or Node APIs.
- **The preload imports only `src/shared/ipc-channels.ts`**, which stays import-free. A sandboxed
  preload cannot `require` anything but Electron built-ins; one stray import chain (zod, a schema
  file) makes the bridge fail to load and leaves `window.km` undefined. ESLint refuses any other
  import in `src/preload` and any import at all in `ipc-channels.ts` (`no-restricted-imports` in
  `eslint.config.mjs`), and `npm run build` runs `scripts/check-preload.mjs`, which fails on any
  other `require` in the built preload bundle.
- `dependencies` holds only what the main process imports at runtime (it is externalized and
  shipped as `node_modules`). Everything renderer-side is a devDependency, bundled by Vite.
- **Renderer hardening is never relaxed:** `sandbox`, `contextIsolation` on, `nodeIntegration`
  off, `setWindowOpenHandler` and the `will-navigate`/`will-redirect` guard route only `http:`
  and `https:` URLs to the OS browser and deny everything else. It lives in `src/main/window.ts`
  (`WEB_PREFERENCES`, `createMainWindow`), outside the bootstrap so `tests/unit/main/window.test.ts`
  can assert every one of those, including that no other web preference is set.

### IPC contract

- Every channel is declared in `src/shared/ipc.ts` with zod input and output schemas and listed in
  `src/shared/ipc-channels.ts`. Main validates both directions.
- The renderer reaches the bridge only through `src/renderer/lib/ipc.ts` (ESLint enforces this).
- Every invoke resolves to the result envelope `{ ok: true, data } | { ok: false, error }`: a
  classified `K8sError` becomes `ok: false` with `kind`, `detail` and `op`, and the renderer's
  `invoke` rethrows it as a typed `IpcError`. Unexpected exceptions still reject; those are bugs.
- Main-to-renderer pushes go through `subscribe` on the bridge, allowlisted in
  `src/shared/ipc-channels.ts` with payload schemas in `ipc-subscriptions.ts`. A hook mirroring a
  push keeps a push that arrives before its initial read answers, since the read is the older of
  the two.

### Renderer stack

- React 19 and TanStack Router, with file-based routes in `src/renderer/routes` and hash history.
  `routeTree.gen.ts` is generated by the Vite plugin during `npm run build` and committed so
  typecheck works without a build.
- A detail route next to a list route uses the `list_.$name.tsx` naming so it renders as a
  sibling, not inside the list's outlet.
- TanStack Query through `useIpcQuery` in `src/renderer/lib/query.ts`.
- Tailwind 4 with shadcn primitives in `src/renderer/components/ui` (add them with the shadcn CLI,
  do not hand roll). `@/` aliases `src/renderer`.
- `eslint-plugin-react-hooks` v7 rules apply: no `setState` inside an effect (derived state resets
  from a tracked key during render) and no mutation of an object a hook handed out.
- `@tanstack/react-table` stays on v8 (v9 is a different API) and `@vitejs/plugin-react` on v5 (v6
  needs Vite 8, which electron-vite 5 refuses); `dependabot.yml` ignores those majors and says why.
- The shadcn CLI writes `import { cn } from "cn"`, installs a `cn` package and puts new packages
  under `dependencies`: fix the import to `@/lib/utils`, uninstall `cn` and move the package to
  `devDependencies`. It also rewrites primitives it added earlier (`button.tsx`, `card.tsx`): diff
  and restore them. Its `sonner` primitive assumes next-themes; ours reads `ThemeProvider`.

### Design system

- Screens are compositions of templates, not bespoke markup.
- Lists render through `ResourceListPage` (`src/renderer/components/templates`) with columns from
  the `list-columns` factories (`nameColumn`, `statusColumn` with the kind's tone map, `ageColumn`,
  `readyRatioColumn`, `textColumn`, `meterColumn` for usage percentages).
- Details render through `ResourceDetail`: the shared header over a left rail of tabs in labeled
  groups (OBSERVE, INSPECT, CONNECT), built from the `overviewTab`, `labelsTab` and `eventsTab`
  factories plus bespoke tabs, with `fill` for panels that scroll themselves and `keepMounted` for
  panels holding live state.
- Cards inside tabs use `DetailCard`, `PropertyGrid`, `KeyValueCard` and `DetailMetrics`.
- Status always goes through `StatusBadge`/`StatusDot` with a `StatusTone` from the per-kind maps
  in `src/renderer/lib/status.ts`. Status vocabularies are per domain (`PodStatus`,
  `DeploymentStatus`, `NetworkStatus`, ...), never one shared enum.
- Navigation (sidebar, breadcrumbs) derives from `DOMAINS` in `src/renderer/lib/nav.ts`, typed
  against the generated route tree, so a new route is added there once. `ALL_DOMAINS` adds
  Settings, which the sidebar renders in its footer next to the `⌘K` command palette
  (`components/layout/command-palette.tsx`).
- Live queries take their poll cadence from `useRefreshIntervalMs` (the `data.refreshIntervalSec`
  setting), never a literal.
- Theme tokens live in `src/renderer/styles/globals.css`; `ThemeProvider` toggles the
  `dark`/`light` root class and persists under `km-theme`. `cn` in `lib/utils.ts` teaches
  tailwind-merge the theme font sizes (`text-body`, `text-meta`, ...) so they are not merged away
  as colors.
- Charts use recharts through the shadcn `chart` wrapper; the summary dashboard is the reference.

### Scope: context and namespace

- Query keys carry no scope, so a context or namespace switch resets every cluster query
  (`invalidateClusterQueries` uses `resetQueries`): screens go back to loading instead of showing
  the previous scope's rows while writes already reach the new one.
- `namespace.active` reports `name: null` under "All namespaces"; the label is the renderer's,
  never a value handed to a cluster call. It is answered from main's own memory, never from the
  cluster, so it is known at once and stays known while the cluster is down.
- The renderer closes a detail page back to its list before switching context (`useSwitchContext`
  in `src/renderer/lib/scope.ts`), since the object it names belongs to the cluster being left.

### Lists

- **No list screen lists the cluster's pods for a count**: the Namespaces and Nodes lists carry no
  pod column, the cluster summary shows no pod total, and the namespace selector and palette show
  names only, because on a busy cluster one such count is megabytes on every refresh.
- Pods are listed only where a detail needs them and scoped to that object: a namespace's own
  screen lists its namespace, a node's screen and describe select on `spec.nodeName`, a workload's
  screen selects its own. The Pods screen's own list and its informer are the only whole-cluster
  pod lists.
- **Narrowing a list is the search box's job**: it matches the rows already on screen against the
  columns on screen, and nothing about it reaches the API server, so a list screen asks for one
  thing only — its kind, in its namespace.
- A namespaced list that times out under "All namespaces" says so and points at the namespace
  selector, since one namespace is a fraction of the cluster; cluster-scoped list screens pass
  `clusterScoped` to `ResourceListPage` so they never give that advice.
- Which **columns** a list shows is a preference about one window, like the theme, so it lives in
  `localStorage` per screen and every access is wrapped, since a private window throws.
- Lists render only the rows in view (`DataTable` over `@tanstack/react-virtual`), so a list screen
  costs the size of the window rather than the size of the cluster — a budget
  `tests/unit/renderer/performance-budget.test.tsx` locks in by counting mounted cells rather than
  milliseconds, which would measure the CI runner instead.
- Pod rows carry the controller that owns them, which is what lets the cluster-wide list group by
  node or by workload (`groupBy` on `DataTable`, which interleaves heading rows into the
  virtualised list rather than nesting tables).
- jsdom lays nothing out, so `tests/setup-renderer.ts` stands in for layout with fixed offset sizes
  and a ResizeObserver that answers once — without those, anything virtualised renders nothing
  under test.

### Watches

- Lists stay live through `resources.watch` (`src/main/k8s/watch.ts`, the client's informer, same
  row transforms as the list) and `useWatchedList` in `src/renderer/lib/watch.ts`, which applies
  events into the list query's cache. Prefer a watch over polling for anything that changes on its
  own.
- One informer serves every screen watching the same kind and namespace (`src/main/k8s/watch.ts`):
  a second screen on the same list replays the informer's cache instead of opening a second watch
  and re-listing, the informer stops when its last subscriber goes, and `stopAllInformers` runs
  when the connection changes.
- A kind whose CRD a cluster need not have (volume snapshots) has no watch source and is polled
  through `usePolledList`; `startResourceWatch` refuses a kind without one.

### Streams

- Streams (`src/shared/streams.ts`, `src/main/ipc/streams.ts`) push many messages over time: the
  preload's `stream()` mints a `sub.<subId>` event and drives `stream.start/send/stop`. Main keys
  every stream by window so one window can never address another's, and sweeps them on reload or
  destroy.
- A stream's `stop` sends `end` itself rather than waiting for the in-flight request to notice, or
  a hung request leaves the renderer watching a cancelled stream.
- The client library's log call pipes an undici body into the sink, and aborting it fails that
  source with an `AbortError` nobody listens to: an uncaught exception in main, which Electron
  answers with a modal dialog that keeps `app.quit()` from completing. So `logs.ts` hears the
  source through the sink's `pipe` event and `will-quit` calls `stopAllStreams`.
- Pod streams (`src/main/k8s/logs.ts`, `exec.ts`, `port-forward.ts`) resolve their target through
  `pod-target.ts` and report a missing pod as an error followed by end rather than throwing; the
  renderer side lives in `src/renderer/lib/pod-streams.ts` with the log buffer capped at 2,000
  lines.
- **Streams never outlive their connection:** every stream shares the one live `KubeConfig`, which
  the client library re-reads on each reconnect and each port-forward connection, so a context
  switch or kubeconfig change ends them all (`endAllStreams`, called from the IPC handlers before
  the switch) with an error naming the reason and then `end`.

### Port forwards

- Port forwards live in `src/renderer/lib/port-forwards.ts`, outside React for the same reason
  shells are, and are listed and stopped from the top bar rather than from the page that started
  one.
- A forward may target a **Service**: main resolves it to a ready endpoint **per connection**
  (`readyPodOf`), so it survives the rollout that would end a forward aimed at one pod.
- Forwards are remembered per context in settings and only ever _offered_ again — reopening a
  local port unasked would be the app deciding something about the user's machine — and a context
  switch stops them all.

### Shells

- **A shell belongs to its pod**: the exec session lives in that pod's Shell tab
  (`src/renderer/components/pod/shell-tab.tsx`), opens when the tab does and ends with it, so
  leaving the pod is how a shell is closed and a terminal is never left attached to a cluster
  nobody is looking at.
- The tab is deliberately not `keepMounted`: merely opening a pod's page must not exec into it.
- `src/renderer/lib/terminal-look.ts` holds the font and the two ANSI palettes, because xterm needs
  literal colours and the app's theme can flip under a running session.
- The app opens no other way in: it attaches no debug container, runs no privileged pod on a node,
  and carries no files across the exec channel — `kubectl debug` and `kubectl cp` are where those
  belong.

### Logs

- **A Logs tab opens already following.** `live` starts on in both the pod tab and the workload one,
  because a log is opened to see what is happening now and a console that has to be switched on
  first is a step in front of the answer. The stream carries the same tail the snapshot did; the
  one-shot `pods.logSnapshot` read is what the tab shows once Live is turned off to hold the view
  still. Both tabs are `keepMounted`, so a follow outlives a switch to another tab of the same
  object and ends with the page.
- A controller's Logs tab follows every pod it owns at once (`src/renderer/lib/multi-pod-logs.ts`):
  the API server has no call for "the logs of this deployment", so it is one stream per pod, merged
  in arrival order and coloured by pod, restarting when the set of pods changes so a replaced pod
  stops being followed.
- The log console renders only the rows in view (`@tanstack/react-virtual`, a devDependency like
  everything else renderer-side), so a buffer of tens of thousands of lines costs a screenful of
  DOM; its size is the `data.logBufferLines` setting, read live so raising it trims differently
  from the next batch on rather than restarting the follow.
- The log console's filtering lives in `src/renderer/lib/log-filter.ts`, apart from the component.
  The search narrows the console by default — a line the search misses is gone, not merely
  unhighlighted — and an unfinished regular expression reads as "no filter yet" rather than emptying
  the console mid-keystroke. `highlight` on the search is the other mode: every line stays and the
  matches are marked where they sit, since a hit is often only legible next to what surrounds it.
  Its toggle is the highlighter icon beside `.*` and `Aa`, because it modifies the search rather
  than how a line reads, which is what the View menu is for; `Toggle` takes an icon as its child and
  keeps `label` as the accessible name, since an icon-only control still has to say what it is. Marking inside a line (`matchRanges`) is only ever
  about saying where a line matched, in either mode.
- **The console's toolbar is one row**, and what stays on it decides _which_ lines are shown: the
  container, the since window, the search and Live. How those lines are _read_ sits behind the View
  button (`log-view-menu.tsx`), so an option can be added without a second row of controls growing
  back. Preferences there are about the window, not the cluster, so they live in `localStorage`
  through `src/renderer/lib/log-view-options.ts` with every access wrapped, shared by every console
  rather than kept per screen. They are one store outside React (`useSyncExternalStore`), because
  the tail is read by the screen opening the log as well as by the console showing it and two copies
  of a preference are two answers. Wrapping changes every row's height, so toggling it re-measures
  the virtualiser.
- An option that defers to the screen is `null`, not a default copied into the store: `timestamps`
  and `tail` start there, so a pod still reads 500 lines and stamps them while a workload reads 100
  per pod and does not, until the reader says otherwise. `TAIL_OPTIONS` contains both screens' own
  defaults, so the picker always has a value to show, and a stored tail outside it is refused.
- Whether a line carries its timestamp starts as the screen's decision — a pod stamps every line, a
  workload following many pods does not, since its rows already spend a column naming the pod — and
  the View menu's switch overrides it. `timestamps` is therefore `boolean | null` in the options,
  where `null` means "as the screen has it"; once the switch is touched the answer is the reader's
  on every console.
- `pods.logDownload` saves the whole log from the API server rather than the buffer on screen,
  capped in main and cut on a line boundary.

### Usage metrics and alerts

- Usage metrics come from metrics-server through an in-memory sampler (`src/main/k8s/sampler.ts`):
  every 12 s it reads pod and node usage plus the node list and keeps bounded ring buffers for the
  cluster aggregate, each node and up to 40 requested pods. Readers start it lazily, a context
  switch resets it and quit stops it.
- Pod and node rows take their `cpu`/`mem` and `cpuUsed`/`memUsed` from the latest sample so
  listed and watched rows agree; no metrics-server means zero usage and empty series, never an
  error.
- **The sampler is in memory on purpose**: its buffers start empty on every launch and a context
  switch resets them, so a chart shows what has happened since the app opened and never claims
  history it does not have.
- Alerts (`alerts.ts`) derive from cluster state, cluster-wide, with thresholds the app decides
  rather than the user.
- Pod alerts never read every pod: pending and failed pods come from `status.phase` field
  selectors, crash loops and image pull failures from the recent Warning `BackOff` events the
  kubelet emits for them (a CrashLoopBackOff pod is phase Running, so no selector finds it),
  deduplicated per pod. There is no high-restarts alert because healthy pods' restart counts are
  never read.

### Resource reads

- Resource reads (`src/main/k8s/resources/*`) are pure transforms from Kubernetes objects to view
  models, exported and unit tested on their own, plus thin readers that fetch and delegate. Keep it
  that way: the watch stream feeds the very same transforms.
- Object events come from `events.forObject` (`src/main/k8s/resources/events.ts`), newest first.
- Aggregates that are not a plain kind (cluster summary, namespaces with pod counts, nodes, events,
  quotas, limit ranges) keep bespoke channels; quotas and limit ranges flatten to one row per
  resource.
- `resources.meta` answers the two parts of `metadata` no view model carries, the controlling owner
  reference and the finalizers holding a deletion open, for any kind at all; `ResourceDetail` adds
  that card to the Labels tab itself rather than thirty screens passing the same three values.
- **A Secret value crosses the bridge one key at a time**: `secrets.entries` returns key names with
  a fixed mask, and `secrets.reveal` answers the single key a reveal or a copy asked for, so no read
  hands the renderer the whole map. The Manifest tab (`resources.getYaml`) shows the object as the
  cluster holds it, values included, because that is what editing it requires.
- A revealed value is held by `useSecretReveal` (`src/renderer/lib/secret-reveal.ts`) alone, never in
  the query cache: it masks itself again after `REVEAL_TIMEOUT_MS` and goes when the page does, and a
  copy puts it on the clipboard without ever rendering it.

### Writes

- Writes (`src/main/k8s/resources/write.ts`) are `resources.create` / `replace` / `delete` /
  `scale` / `restart`.
- A restart is a strategic merge patch stamping the pod template's
  `kubectl.kubernetes.io/restartedAt` annotation (the key kubectl writes, so both read as one
  history), which is why only the kinds in `RESTARTABLE_KINDS` can be restarted at all and why
  nothing here deletes a pod.
- Create and replace go through `apis().objects`, which derives the API path from the manifest's
  own `apiVersion`/`kind`, so a CRD rides the same call as a Pod. A replace must carry the
  `metadata.resourceVersion` it was read with, which is what turns a concurrent change into a
  `conflict` instead of a silent overwrite.
- **Writes fail closed on targeting.** Every write input carries a `context` stamp, the context the
  screen was rendered under; main compares it with the context it is on and refuses a mismatch as
  `conflict`, so rows left over from before a context switch can never act on the new cluster. The
  renderer adds the stamp in `src/renderer/lib/writes.ts`; screens never pass it.
- A delete or scale of a namespaced kind must name its namespace and a cluster-scoped kind must not
  (`refineManifestTarget` in `src/shared/k8s/manifest.ts` enforces it at the boundary); the active
  namespace is never consulted for a destructive write.
- A create or replace whose manifest names no namespace takes the active one, and with none
  selected is refused rather than left to the client library's default; an unknown kind is asked of
  API discovery to learn whether it is namespaced.
- A replace from the editor carries `expect`, the object the panel was opened on, and a manifest
  that names any other kind, name or namespace is refused.
- Single-object reads follow the same rule: `getNamespaced` and `resources.getYaml` answer not
  found or `invalid` when no namespace is known, never the first same-named object across the
  cluster.
- Manifests are serialized by `src/main/k8s/yaml.ts` with plain js-yaml, never the client library's
  typed dump, which drops fields it does not know.
- Renderer side: every write goes through `useIpcMutation` (`src/renderer/lib/query.ts`) with
  per-domain invalidation, never a blanket one, and every rejection surfaces through the shared
  mutation-error toast.
- Deleting a kind in `DANGEROUS_KINDS` (nodes, CRDs, cluster-wide plumbing) asks the user to type
  the name, and those kinds have no bulk delete.

### Kinds and the registry

- **Kinds go through the generic channels.** `src/shared/k8s/registry.ts` holds one entry per kind;
  `resources.list` and `resources.get` take a `kind` and return a union discriminated on it
  (`src/shared/k8s/resources.ts`), with per-kind fetchers registered in
  `src/main/k8s/resources/index.ts`.
- Adding a kind:
  - a registry entry;
  - a view-model schema (a row and, when the detail shows more, a detail extension with label
    pairs);
  - transforms plus readers;
  - union members in `resources.ts` and `streams.ts`;
  - a fetcher entry;
  - a watch source in `watch.ts`;
  - a list entry in `resources/manifest.ts` (typed over every kind, so a new one fails to compile
    until its manifest is readable too);
  - a `list/index.tsx` plus `list/$namespace.$name.tsx` route pair;
  - a navigation item and a tone map.
- Detail routes carry the namespace: `/workloads/pods/$namespace/$name`. Cluster-scoped kinds
  ignore the active namespace in their readers and watch paths, and their detail routes use the
  `list_.$name.tsx` naming.
- ReplicaSets and ReplicationControllers list as their own kinds too, each row naming the
  controller above it from its owner reference (`ownerLabel`), which is the only way to tell two
  rollouts of one deployment apart.
- Batch kinds read through `apis().batch`, autoscalers through `apis().hpa`.
- PodDisruptionBudgets, PriorityClasses and Leases read through `apis().policy`,
  `apis().scheduling` and `apis().coordination`; a budget allowing no disruption reads Blocked,
  since a drain stops on it and no count says so on its own.
- RuntimeClasses and IngressClasses are the class kinds other objects point at by name, read
  through `apis().runtime` (the `node.k8s.io` group, which holds no nodes) and `apis().net`; the
  CSI kinds (drivers, nodes, storage capacity) read through `apis().storage`.
- A CSIDriver's `attachRequired` defaults to **true** when unset, unlike its other flags, so an
  omitted spec must not read as a driver that needs no attach step.
- The admission kinds (webhook configurations, ValidatingAdmissionPolicies) read through
  `apis().admission`, APIServices through `apis().apiregistration` and FlowSchemas through
  `apis().flowcontrol`.
- A webhook configuration reads Blocking when any of its webhooks fails closed — the API's own
  default when `failurePolicy` is unset — because such a configuration is a dependency of writing
  at all, and an unavailable APIService explains why a whole API group's kinds have vanished.

### Custom resources

- **Instances of a CRD** go through `customResources.list`/`get`/`getYaml` instead
  (`src/main/k8s/resources/custom.ts`): the app cannot know these kinds in advance, so everything a
  row shows comes from the definition itself — its storage (or first served) version, its scope,
  and the `additionalPrinterColumns` `kubectl get` would print.
- Those columns are evaluated with the small JSONPath subset they actually use (dotted keys,
  `['quoted']` keys, `[0]` indexes; filters and wildcards are refused rather than half-evaluated).
- Editing rides the same `resources.replace` as every other kind, since that call derives the API
  path from the manifest's own `apiVersion` and `kind`; the editor's `expect` pin therefore takes a
  kind name rather than a registry kind, and scope is checked only for kinds the registry knows.

### Namespaces

- **A namespace has a screen of its own** (`namespaces.detail`): it does nothing by itself, so its
  detail is a roll-up — what lives in it (each count linking to that kind's list), the quotas and
  limit ranges it carries, and the usage of its pods against what they asked for.
- `Namespace` joins `Node` as a manifest kind outside the registry so it can be read, created and
  deleted through the ordinary write path, and it is in `DANGEROUS_KINDS`, since deleting one takes
  every object inside it.

### Related objects

- **Related objects** (`resources.related`, `src/main/k8s/resources/related.ts`) answer what else
  an object is tied to, and every link says _why_: "mounted as volume", "envFrom in web", "selects
  these pods", "runs as".
- A relation that cannot be explained is a guess, so everything comes from the object's own spec or
  from a selector that actually covers its labels — never from names that merely look alike. Pods
  first, since a pod is where every relation is concrete.

### Deployments and rollouts

- `deployments.compare` puts two revisions' pod templates side by side, both through the same
  `canonical()` the rollback skip check uses, so a difference on screen is one somebody made rather
  than one the API server filled in. The diff itself is a plain LCS over lines in
  `src/renderer/lib/line-diff.ts`, which keeps it testable without a browser and adds no
  dependency.
- Deployments also have `deployments.replicaSets`, `deployments.rollouts`,
  `deployments.rolloutStatus` and `metrics.deploymentSeries` (the sum of the selected pods' tracked
  series).
- The two writes that belong to a rollout rather than to a kind in general, `deployments.rollback`
  and `deployments.pause`, live in `resources/workloads.ts`, next to the ReplicaSet readers they
  share, and go through the same `assertContext` guard as every other write.
- A rollback restores a revision's pod template with a **JSON** patch, never a strategic merge: a
  merge would merge container lists by name, so a container added after the target revision would
  survive the rollback meant to undo it.
- A revision whose template already matches the live one is reported as `skipped` instead of
  written, and template comparison canonicalises both sides (keys ordered, blanks dropped, the
  controller's `pod-template-hash` label ignored) because the API server fills the two copies out
  differently.

### Node actions

- Node actions live in `src/main/k8s/drain.ts`. `nodes.cordon` patches `spec.unschedulable`, and a
  drain is a stream (`nodes.drain`) rather than an invoke, because it writes for minutes and
  reports each pod as it goes.
- `nodes.drainPlan` answers what a drain would do for the options the dialog shows, and the drain
  re-derives the same plan itself, so the screen can never promise one thing and main carry out
  another.
- Eviction is what honours PodDisruptionBudgets: a 429 means "not now", so the loop waits and
  retries to its own two-minute deadline per pod. That loop is the one cluster call outside
  `withK8s` — the read timeout is the wrong ceiling for something whose job is to keep asking, and
  the eviction status codes must stay readable.
- Stopping ends the stream at once and leaves the node cordoned; undoing that is the operator's
  decision.

### Helm

- Helm (`src/main/k8s/resources/helm.ts`) has no API of its own: a release is a Secret of type
  `helm.sh/release.v1` whose `release` field is base64(gzip(json)), base64'd again by the API, with
  one Secret per revision named `sh.helm.release.v1.<name>.v<n>`. Reads decode those Secrets.
- The writes (`releases.rollback`, `releases.uninstall`) act on the objects a revision's stored
  `manifest` rendered and then keep Helm's own bookkeeping straight — same Secret names, labels and
  status words — so a release this app rolls back stays one the Helm CLI can read and act on.
- A rollback re-applies the target revision's objects, removes what that revision never had,
  records the result as a **new** revision (Helm numbers forward, it never rewinds) and marks the
  previous one superseded.
- An uninstall deletes the current revision's objects and either forgets the history or marks it
  uninstalled.
- Objects annotated `helm.sh/resource-policy: keep` are never deleted by either, and are counted
  back to the caller.

### Container detail

- A pod's containers come back as one ordered list carrying a `role` (init, app, ephemeral) rather
  than three lists, so the screen labels each without knowing the shape of the pod spec.
- Usage is per container: `readUsage` keeps both the pod totals lists show and the per-container
  figures the rows put beside their requests, read once so the two cannot disagree, and the request
  travels as a number as well as a string so the renderer never parses quantities.
- `autoscalers.update` adjusts an HPA's bounds, and its CPU target only when the caller asked, so
  an autoscaler watching other metrics keeps watching them.

### Lifecycle writes

- Lifecycle writes live in `src/main/k8s/resources/lifecycle.ts`. `pods.evict` goes through the
  eviction API so PodDisruptionBudgets still have a say (a delete does not); `resources.delete`
  carries an optional `gracePeriodSeconds`, and zero is the forced delete the pod dialog offers.
- `jobs.retry` deletes and resubmits — a job's spec is immutable once it has run — using foreground
  deletion and then waiting for the name to come free, so the create cannot race a half-deleted
  job. That whole sequence gets its own `withK8s` ceiling, because the default read timeout would
  cut it short and report a timeout where the truth is "the old run is still finishing".
- `cronJobs.trigger` builds a job from the cron job's template owned by nobody, so history limits
  never sweep a manual run away, and `jobFromTemplate` strips the selector and the uid labels the
  control plane stamps, which would otherwise bind the new job to the old one's pods.

### Describe

- `resources.describe` (`src/main/k8s/resources/describe.ts`, `src/shared/k8s/describe.ts`)
  answers a structured document — sections of labelled rows, with blocks for the parts that repeat
  — rather than pre-rendered text, so the screen lays it out and `describeToText` produces the copy
  and download from the very same document.
- Pods and nodes only; every other kind has the manifest, which says the same thing in YAML.
- The transforms are pure over a Kubernetes object plus its events, so the whole view is tested
  without a cluster.

### Ownership

- Ownership (`src/main/k8s/resources/owners.ts`) is resolved through the API's own owner
  references, never label selectors: a selector says which pods a controller _would_ adopt, the
  references say which it _has_, and two workloads can share labels but never a reference.
- `pods.owners` walks a pod up through the one intermediary its kind allows (a ReplicaSet to its
  Deployment, a Job to its CronJob) and stops; `workloads.pods` goes the other way, resolving a
  controller's owning uids first.
- A link carries a `path` only when the registry has a screen for that kind, so a ReplicaSet is
  named but not linked until that kind exists. A broken link higher up ends the chain rather than
  failing it.
- Restarting from the pod screen rolls the owning workload, because a pod deleted on its own comes
  back unchanged.

### Kubernetes access

- Kubernetes access lives in `src/main/k8s`. The kubeconfig is read-only: switching context or
  namespace changes memory and the app's own settings, never the file.
- Every cluster call goes through `withK8s` (timeout plus `[kind]`-prefixed `K8sError`).
  `errors.ts` classifies them: `timeout` is only `withK8s`'s own ceiling, and a connect failure is
  `unreachable`, including undici's `UND_ERR_CONNECT_TIMEOUT`, which the client library nests under
  a bare `TypeError: fetch failed` and which fires before the ceiling does.
- The ceiling is the `data.readTimeoutSec` setting (60 s by default), applied to `errors.ts` at
  startup and on every settings write rather than read per call, so the k8s modules never import
  the settings store; a timed-out list or summary points at Settings, since how long a cluster may
  take is the user's to say.
- The kubeconfig loads with `onInvalidEntry: 'filter'`: an entry with no name, an empty `cluster:`
  or a cluster without a server is dropped, as kubectl tolerates it, instead of failing the whole
  file and every other context with it.
- **A kubeconfig that will not load never blocks the shell:** the load failure is a `kubeconfig`
  error on every cluster call (`K8sError`, with the sentence `kubeconfigError` composes rather than
  the parser's message, which quotes the file), the startup gate lets the app through, and the top
  bar's `ConnectionNotice` carries the failure with its three fixes (try again, choose a
  kubeconfig, use the default), reading the same `startupChecks` report the gate fetched.
  `recheckConnection` in `src/renderer/lib/settings.ts` refetches it and resets the cluster
  queries, so a fix from the notice or from Settings clears both. The startup error card remains
  only for a bridge that cannot answer at all.
- A file that loads can still carry a **context whose cluster or user entry is missing** (filtered
  out, or removed while the context stayed): the library lists it, switches to it and then fails
  every call with "No active cluster!". `contextProblem` in `client.ts` names the missing entry,
  `apis()` fails closed with it as a `kubeconfig` error, every listed `KubeContext` carries it as
  `problem` so the selector marks the entry, the `context` startup check reports it (the cluster
  probe is skipped) and the notice reads "Context unusable" with a hint to switch. A context switch
  reruns the startup checks so the notice follows the current context.
- No `kubectl` dependency; the client library handles exec credential plugins itself. Two things
  make that work outside a terminal:
  - main adopts the login shell's PATH at startup (`src/main/shell-path.ts`), because a Finder or
    Dock launch inherits launchd's `/usr/bin:/bin:/usr/sbin:/sbin` and a kubeconfig written by
    `aws eks update-kubeconfig` names its plugin by bare command;
  - every loaded `KubeConfig` has its authenticators wrapped (`src/main/k8s/exec-auth.ts`) so a
    plugin that is missing or exits non-zero surfaces as `unauthorized` with a sentence naming the
    plugin, not as the CLI's stderr under "Something went wrong".

### Settings

- Settings (`src/shared/settings.ts`, `src/main/settings/store.ts`) are a versioned JSON file in
  Electron's `userData`.
- The settings screen at `/settings` edits them through `settings.set`; the application menu
  (`src/main/menu.ts`) opens it with `Cmd+,` on macOS by pushing `open-settings`.
- Theme lives in renderer `localStorage`, not here, because it must apply before first paint.
- The renderer can never set the kubeconfig path; that goes through the native dialog channel
  `kubeconfig.pick`. It cannot set `window.bounds` either: `settingsInputSchema` omits the section,
  main writes it alone.
- `KUBERMEISTER_USER_DATA` redirects `userData`, which is how tests isolate the app.

## Release model

One channel, released often. `ci.yml` runs on every pull request and every push to `main`, and
`release.yml` calls it as its gate. There is no nightly or pre-release build; a fix reaches users
through the next release.

### Cutting a release

- A release (`.github/workflows/release.yml`) is a `vX.Y.Z` tag whose version matches package.json:
  draft release, package on three OSes, upload installers named
  `Kubermeister-<version>-<os>-<arch>.<ext>` plus electron-updater metadata (`latest*.yml`,
  blockmaps), publish as latest.
- Cutting a release: merge a `chore(release): X.Y.Z` PR that bumps package.json, then
  `git tag vX.Y.Z && git push origin vX.Y.Z`.
- The `verify` job refuses a tag whose version differs from package.json and a tag whose commit is
  not on `main`, before anything is built: a tag on any other commit would still publish as latest
  and update the cask. A tag ruleset restricts creating, moving and deleting `v*` tags to admins.
- The `package` job installs with no npm cache (`package-manager-cache: false`): its output is what
  users install, and a cache entry written by any other run would feed straight into it.
- **The app shows no release notes.** Generated notes are a list of pull-request titles, dozens of
  lines with an author and a URL on each, so the popover, the toast and the Settings About card give
  the version and its date and link to the release page, and the native dialog offers it as a
  `Release Notes` button. Nothing flattens the feed's HTML and `UpdateState` carries no notes.

### Names, repositories and the Homebrew tap

- Asset names, the app id and the product name are load-bearing for the updater and the Homebrew
  cask; change them together with the workflow.
- The repositories live under the `kubermeister` organization and moved there from the maintainer's
  own account; GitHub redirects the old URLs, which is what keeps the feed embedded in older
  installs updating, so no repository named `kubermeister` may ever be created under the old owner.
- The cask is rendered from `packaging/homebrew/kubermeister.rb.tmpl` and pushed to
  `kubermeister/homebrew-tap` with `HOMEBREW_TAP_TOKEN`, a fine-grained token whose resource owner
  must be the organization.

### Packaging and signing

- Every `setup-node` step passes `check-latest: true`, because a runner's cached Node 24 can bundle
  an npm older than the engine gate.
- The workflows are linted in the `checks` job: actionlint for syntax, expressions and shell steps,
  zizmor (medium severity and up) for security posture. Every checkout sets
  `persist-credentials: false` except the Homebrew tap checkout, which pushes with its token. A
  deliberate exception carries an inline `# zizmor: ignore[audit]` next to a comment saying why;
  `pr-labels.yml` has one for `pull_request_target`, which it needs to label fork PRs and which is
  safe because that workflow checks nothing out. Locally: `pipx run zizmor --min-severity medium
.github` and `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint`.
- Dependabot waits seven days after a version is published before proposing it (`cooldown`), since
  a package compromised on the registry is usually pulled within days.
- Packaging runs through `.github/actions/package`: with the `CSC_*` and `APPLE_*` secrets macOS is
  Developer ID signed and notarized, otherwise ad-hoc signed; never export an empty `CSC_LINK`.
- **Electron fuses** (`electronFuses` in `electron-builder.yml`, locked by
  `tests/unit/repo/electron-builder.test.ts`) are flipped in the binary at package time and read
  before any JavaScript runs. `runAsNode`, `NODE_OPTIONS` and the inspect arguments are off, so the
  signed app cannot be started as a plain Node binary or have a script preloaded into main;
  `onlyLoadAppFromAsar` and the embedded ASAR integrity check are on. The file protocol privileges
  fuse stays at its default because the packaged renderer is a `file://` document, and
  `resetAdHocDarwinSignature` re-signs an unsigned build so it still opens. The end-to-end suite
  drives `out/` through the development Electron binary, so fuses are checked on a packaged build
  (`npm run package:dir`, then `npx electron-fuses read --app release/<os>/Kubermeister.app`).
  Playwright's `_electron.launch` cannot drive a packaged build any more, since it attaches to main
  with `--inspect`, which the fuse ignores: start the binary with `--remote-debugging-port` and
  connect with `chromium.connectOverCDP`, which reaches the renderer without the Node inspector.
- Icons regenerate from `resources/icon.svg` with `resources/build-icon.sh`.

### In-app updates

- `src/main/updater.ts` (electron-updater) reads the feed electron-builder embeds at package time;
  macOS updates need the `zip` target next to the dmg.
- The library never downloads on its own: the `updates.mode` setting (`check` by default,
  `download`, `off`) is read the moment a version is found, and `updates.checkIntervalHours` (4 by
  default) spaces the scheduled checks after the 15 s launch delay. `applyCheckInterval` runs on
  every settings write and reschedules from now only when the value changed, so a write of anything
  else never pushes the next check out.
- Main pushes every transition as `update.state`, which `useUpdater` in
  `src/renderer/lib/updates.ts` mirrors for the top-bar `UpdatePill` (popover plus one-shot toasts)
  and the Settings About card; the palette reaches `update.check` too.
- **The menu's "Check for Updates…" needs no renderer:** it runs `src/main/update-dialog.ts`,
  native message boxes for the outcome, the download and the restart, because the pill and Settings
  only exist once the renderer has mounted, and an update found while a white screen or a crashed
  renderer keeps it from mounting must still have a way in.
- A failed scheduled check is stored with `background: true` and never surfaces as a notification.

### Publishing

- **Publishing is fail-safe, not fail-proof:** GitHub's upload service does fail a large asset now
  and then, so the packaging action uploads one file at a time with retries, reads every asset back
  and checks its size and checksum, and only then uploads the `*.yml` feed.
- Installer names carry the version, so a new build never overwrites the files a live feed points
  at, and any failure leaves the previous build complete; the feed file is the one asset written in
  place.

## Testing

### Principles

- **Tests come first.** A feature is specified by its tests before it is wired in, and every
  feature PR ships with them. Behaviors include error paths, not only the happy path.
- **No test ever touches a real cluster or the developer's kubeconfig.** Unit tests mock the
  Kubernetes client at the module boundary and never open a network connection. End-to-end tests
  run against a disposable k3s container started by Testcontainers, with a kubeconfig written for
  that container only and a throwaway settings directory that pins it; `~/.kube/config` and
  `$KUBECONFIG` are never read. A guard in the end-to-end setup fails the whole suite if the active
  context is anything but the test cluster's.

### Unit tests (Vitest)

- `vitest.config.ts`, Node environment. `tests/unit/` mirrors `src/`
  (`tests/unit/main/updater.test.ts` tests `src/main/updater.ts`).
- Main-process modules mock `electron` and other runtime packages at the module boundary with
  `vi.mock`; shared schemas are tested directly.
- Pure renderer logic lives in `src/renderer/lib` so Vitest can reach it without a DOM.
- **Coverage** (`npm run test:coverage`, V8) covers `src/main`, `src/shared` and the renderer except
  the process bootstraps, the generated route tree, the route files and the shadcn primitives.
  Thresholds in `vitest.config.ts` fail CI when missed and only ever go up. Bootstrap, preload and
  route code are covered end to end.
- Run one file: `npx vitest run tests/unit/main/updater.test.ts`. Watch: `npm run test:watch`.

### Component tests

- `tests/unit/renderer`, jsdom project, Testing Library. Mock `@/lib/ipc` at the module boundary
  and render through `renderWithQuery`, or `renderRoutes` for anything that needs the router or the
  shell (both wrap the theme, query and tooltip providers).
- Radix menus and popovers open under jsdom thanks to the ResizeObserver, pointer-capture and
  `Range.getClientRects` stubs in `tests/setup-renderer.ts`.
- Hooks use block bodies: a mock returned from `beforeEach(() => fn.mockReset())` is treated as a
  teardown and called with no arguments.
- `vi.fn` arrow mocks are not constructible; mock a class with a class.
- Attach a `rejects` matcher before advancing fake timers, or the rejection goes unhandled.
- Assert a Radix tooltip on focus, not hover, which never opens it under CI's jsdom.
- `DetailCard` forwards no `data-testid`, so a unit test asserts the test id an end-to-end spec
  reads before that spec relies on it.

### End to end (Playwright)

- `playwright.config.ts`, `tests/e2e/`. Drives the built app, so run `npm run build` before
  `npm run test:e2e`. Needs Docker; ubuntu only in CI.
- `harness/cluster.ts` starts the k3s container, `harness/isolation.ts` is the guard,
  `harness/launch.ts` launches the app with a throwaway `KUBERMEISTER_USER_DATA` and
  `KUBERMEISTER_SHOW_INACTIVE`, so the window never takes focus and keystrokes typed during a local
  run stay in the terminal.
- `KM_E2E_KEEP_CLUSTER=1` keeps the container between local runs; its id is kept in
  `tests/e2e/.cluster.json`. A kept cluster ages out its seeded events after about an hour, so
  remove the container and that file before trusting a failing local run.
- The seed applies in two passes, since a CRD and its instances cannot land together: the harness
  waits for `Established`, then applies `fixtures/seed-custom.yaml`.
- Traefik is disabled, so Helm coverage comes from two encoded release Secrets in the seed rather
  than a chart the cluster installed, and the seeded PodDisruptionBudget selects nothing, because
  one covering running pods would block the eviction spec on a one-node cluster.
- Playwright's `getByRole` matches names by substring: pass `exact: true`, or 'Nodes' also finds
  CSINodes.

## Code style

- Prettier (`.prettierrc`) and EditorConfig (`.editorconfig`) are authoritative. 4 spaces for
  source, 2 for JSON, YAML, Markdown. Single quotes, semicolons, 120 columns.
- Never `any` in TypeScript.
- Comments explain why, not what.
