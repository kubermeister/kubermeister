# Kubermeister

[![CI](https://github.com/kubermeister/kubermeister/actions/workflows/ci.yml/badge.svg)](https://github.com/kubermeister/kubermeister/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/kubermeister/kubermeister?label=release)](https://github.com/kubermeister/kubermeister/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A fast, native desktop client for browsing and managing Kubernetes clusters, for macOS, Windows and
Linux.

Kubermeister reads the kubeconfig you already have and needs nothing else installed: no `kubectl`,
no plugins, no agent in the cluster. Every screen stays live through the API server's own watches,
so what you see is what the cluster is doing right now.

<!-- Screenshots go here, from docs/screenshots/<theme>/: summary.webp, pod-logs.webp, manifest-editor.webp -->

## What it does

### See the cluster

- **Cluster summary.** Nodes, workloads and capacity at a glance, live CPU and memory sparklines
  from metrics-server, alerts for what needs attention, and a stream of recent events.
- **Nodes.** Conditions, system info, allocatable capacity against usage, and the pods scheduled on
  each node. Cordon and uncordon a node, or drain it with a plan you can read before it runs.
- **Namespaces.** A roll-up of everything a namespace holds, the quotas and limit ranges it carries,
  and its pods' usage against what they asked for.
- **Events, quotas, limits**, priority classes, leases and runtime classes.

### Every kind, one way

Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets and ReplicationControllers; Jobs and
CronJobs; ConfigMaps, Secrets, autoscalers and PodDisruptionBudgets; Services, Ingresses, Endpoints,
IngressClasses and NetworkPolicies; PersistentVolumes, claims, StorageClasses, VolumeSnapshots and
the CSI kinds; ServiceAccounts, Roles, RoleBindings, ClusterRoles and ClusterRoleBindings; Helm
releases and charts, CustomResourceDefinitions, admission webhooks and policies, APIServices and
FlowSchemas.

Every list follows a watch, so objects appear, change and disappear as the cluster changes. A list
renders only the rows in view, so a cluster with thousands of pods costs no more than one with ten.
Search, sorting and per-screen column choice sit on top; the pod list can group by node or by the
workload that owns each pod.

Instances of a custom resource get the same treatment: Kubermeister reads the definition and shows
the printer columns `kubectl get` would print, for any CRD installed in the cluster.

### Understand one object

Every detail screen has an overview, the object's events, its labels and annotations, the owner
that controls it and the finalizers holding a deletion open, and the live manifest as YAML.

- **Pods** add logs with search and a since-window, an interactive shell, port forwarding, a
  `describe` view, and a Related tab that names every ConfigMap, Secret, Service, Ingress,
  NetworkPolicy, volume claim and ServiceAccount the pod is tied to, with the reason for each link.
- **Deployments** add rollout history with rollback, pause and resume, a live rollout status, and
  a side-by-side comparison of any two revisions' pod templates.
- **Workloads** stream the logs of every pod they own, merged and coloured by pod, and follow
  replacements as pods come and go.
- **Services** show ports and endpoints; **Ingresses** show their rules; **Helm releases** show
  their revision history and the values they were installed with.

### Change it, carefully

Create from a template or a pasted manifest, edit any manifest in place, scale, restart a
workload's pods, trigger a CronJob, retry a Job, evict a pod, roll a Deployment or a Helm release
back, and delete one object or a selection. Every write can be checked first with a dry run, and an
edit that lost a race to another writer is reported rather than silently applied.

### Keep secrets secret

Secret values are never read for the list or detail views. They appear only in the manifest, where
the cluster itself stores them, because that is what editing one requires.

## How it works

Kubermeister is an Electron app whose renderer is fully sandboxed: no Node.js access, no direct
network access, and a typed message bridge to the main process that validates every request and
every response against a schema. Cluster access lives in the main process alone, through the
official Kubernetes JavaScript client.

A few rules hold everywhere:

- **The kubeconfig is read-only.** Switching context or namespace changes the app's own settings,
  never the file. Exec credential plugins (cloud provider logins, OIDC helpers) run exactly as they
  would for `kubectl`.
- **Writes fail closed.** Every write carries the context the screen was rendered under, and the
  app refuses it if the connection has moved on, so a stale screen can never act on a different
  cluster. A destructive write names its namespace explicitly rather than trusting the active one.
- **Streams end with their connection.** Logs, shells, port forwards and watches all close when the
  context or kubeconfig changes, with an error that says why.
- **Metrics are optional.** Without metrics-server the app shows no usage figures and raises no
  error. Usage history lives in memory and starts fresh each launch, so a chart never claims history
  the app did not see.
- **Dangerous deletes ask twice.** Deleting a node, a namespace, a CRD or other cluster-wide
  plumbing requires typing the object's name, and those kinds have no bulk delete.
- **Nothing runs in the cluster.** The app installs no agent, attaches no debug container and runs
  no privileged pod. Reach for `kubectl debug` when you need one.

## Requirements

- macOS 13 or newer (Apple silicon or Intel), Windows 10 or newer (x64), or a Linux distribution
  that can run an AppImage or install a `.deb` (x64). The AppImage carries its own runtime and needs
  nothing installed first.
- A kubeconfig with at least one context. Any cluster the current Kubernetes API speaks to should
  work; releases are tested end to end against k3s.
- [metrics-server](https://github.com/kubernetes-sigs/metrics-server) for usage figures and
  charts. Everything else works without it.

## Installation

Every version is a `vX.Y.Z` tag on the
[Releases](https://github.com/kubermeister/kubermeister/releases) page, with installers for each
platform attached.

A `SHA256SUMS` file is attached to each release. To check a download against it, from the directory
holding both:

```sh
sha256sum --ignore-missing -c SHA256SUMS      # Linux
shasum -a 256 --ignore-missing -c SHA256SUMS  # macOS
```

```powershell
# Windows: compare the printed hash with the line for your file in SHA256SUMS
Get-FileHash .\Kubermeister-*-win-x64.exe -Algorithm SHA256
```

### macOS

Download the `.dmg` for your Mac: `mac-arm64` for Apple silicon, `mac-x64` for Intel. Open it and
drag the app into Applications. Builds are signed and notarized, so the app opens without any
security prompt.

Or install with [Homebrew](https://brew.sh). Homebrew 7 requires third-party taps to be trusted
once before anything from them can be installed:

```sh
brew trust kubermeister/tap
brew install --cask kubermeister/tap/kubermeister
```

### Windows

Download the `win-x64.exe` installer and run it. The installer is not code-signed yet, so Windows
SmartScreen shows a warning on first run: choose **More info**, then **Run anyway**. This happens
once per install.

### Linux

Two packages, and the choice decides how the app is updated and whether it appears in your
launcher. Both are x64.

**AppImage** — one file, no install, **updates itself**. Download `linux-x86_64.AppImage`, make it
executable, and run it.

```sh
chmod +x Kubermeister-*-linux-x86_64.AppImage
./Kubermeister-*-linux-x86_64.AppImage
```

It adds no menu entry and no icon of its own, so it is a file you keep somewhere and run, unless you
integrate it with something like [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher).

**Debian / Ubuntu** — installs properly, **updated by you**. Download `linux-amd64.deb` and install
it.

```sh
sudo apt install ./Kubermeister-*-linux-amd64.deb
```

This one lands in the launcher with its icon, and `apt` owns it: the app never replaces itself, it
only tells you when a version is out and links to the download. Upgrading is installing the new
`.deb` over it.

### Updating

The app checks for updates shortly after launch and every few hours. A new version is fetched in
the background and installed the next time you quit; a pill in the top bar says one is ready and a
restart finishes it sooner. Only the changed parts are fetched, so an update is usually a fraction
of the installer's size, and the popover names what it is downloading. Settings › Updates chooses
between that, being asked before anything is downloaded, or never checking automatically, and its
About card shows the installed version and a **Check for updates** button; the same check is in the
application menu and the ⌘K palette.

That is the macOS app, the Windows installer and the Linux AppImage, each of which can replace
itself. A package the system owns — the Linux `.deb`, and Homebrew — cannot be replaced by the app
without lying to the package manager about what is installed, so it is never tried: the app says a
new version exists and links to it, and you install it the way you installed this one (`brew
upgrade` for Homebrew). Installing a newer download over the existing app always works, and settings
are kept either way.

### Configuring

Settings live in `~/.config/kubermeister/settings.json` on every operating system (or under
`$XDG_CONFIG_HOME`, or wherever `KUBERMEISTER_CONFIG` points). Every key is optional and a change
made in the app rewrites only that key, so the file can be written by hand, kept with your dotfiles
and provisioned onto a new machine:

```json
{
  "data": { "refreshIntervalSec": 5, "readTimeoutSec": 120 },
  "network": { "proxyMode": "manual", "proxyUrl": "http://proxy.corp:3128" }
}
```

Every key, its values and its default are in [the settings reference](docs/reference/settings.mdx#the-settings-file).

## Building from source

You need Node.js 24 and npm 11.19 or newer.

```sh
git clone https://github.com/kubermeister/kubermeister.git
cd kubermeister
npm install
npm run dev          # Electron with hot reload
```

| Command             | What it does                                                 |
| ------------------- | ------------------------------------------------------------ |
| `npm run build`     | Compile main, preload and renderer into `out/`               |
| `npm run package`   | Build installers for the current OS into `release/`          |
| `npm run test`      | Unit and component tests (Vitest)                            |
| `npm run test:e2e`  | End-to-end tests against a disposable k3s container (Docker) |
| `npm run lint`      | ESLint                                                       |
| `npm run typecheck` | TypeScript, both the Node and the renderer projects          |
| `npm run format`    | Prettier over the whole repository                           |

No test ever touches a real cluster or your kubeconfig. Unit tests mock the Kubernetes client, and
the end-to-end suite starts its own k3s container, writes a kubeconfig for that container only, and
aborts if the active context is anything else.

## Contributing

Issues and pull requests are welcome: the [bug report](https://github.com/kubermeister/kubermeister/issues/new?template=bug_report.yml)
form asks for what a fix needs, and the open issues labelled
[`good first issue`](https://github.com/kubermeister/kubermeister/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22)
are a place to start. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, the checks
a change has to pass and the branch and commit conventions; [`AGENTS.md`](AGENTS.md) documents the
architecture and the rules the codebase holds itself to. Security problems go through
[SECURITY.md](SECURITY.md), never a public issue.

## License

[MIT](LICENSE)
