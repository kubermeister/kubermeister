# Changelog

What changed in each release, written for somebody deciding whether to update. It is kept by hand:
the release notes on GitHub already list every pull request, and a second copy of that list would
say no more than the first. A line here is about the app, not about the change — what it now does,
or what stopped going wrong — and work nobody outside the repository would notice is left out.

Every release is here, from the first. The list of pull requests behind each one is on the
[releases page](https://github.com/kubermeister/kubermeister/releases).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A Helm release opens on a **Resources** tab listing every object its current revision rendered,
  read live from the cluster with each one's own status, under a health roll-up that names the
  object making the release unhealthy, such as one that is missing.
- Linux builds for arm64, as an AppImage and a `.deb`, which update the same way as the x64 ones.

### Fixed

- A detail page that cannot be read says why — no permission to see the object, credentials the
  cluster rejected, a cluster that did not answer or took too long — instead of only "Failed to
  load", and a custom resource or Helm release that has been deleted reads as not found.
- An object deleted from its own page no longer stays listed after you land back on its list,
  which happened when the list had still been refreshing as you left it.

## [0.7.0] - 2026-09-25

### Added

- Keyboard shortcuts for moving between the six domains (`⌘1` to `⌘6`, or `Ctrl+1` to `Ctrl+6`),
  going back and forward, focusing the screen's search box with `/`, and opening Settings with `⌘,`
  or `Ctrl+,` on every platform, with a cheat sheet on `?`, in **Help › Keyboard Shortcuts** and in
  the command palette.
- **Copy link**, beside the breadcrumbs on every detail page, copies a `kubermeister://` link that
  names the cluster by its API server, so it opens the same page and tab for anybody whose
  kubeconfig reaches that cluster, whatever their context for it is called. Opening one asks before
  it switches context and never does more than open the page.

### Changed

- `⌘R` and `Ctrl+R` refresh the screen's data instead of reloading the window, which ended every
  port forward, shell and log follow; **View › Force Reload** still reloads it.
- A detail page keeps its tab through a reload, and returning to an object with Back opens the tab
  you left it on, rather than Overview.
- Starting Kubermeister while it is already running brings the open window forward instead of
  starting a second copy.

## [0.6.2] - 2026-09-24

### Fixed

- The manifest editor checks and completes against the cluster's schema on a real cluster. In 0.6.1
  every schema lookup failed, so the editor quietly stayed plain YAML.

## [0.6.1] - 2026-09-24

### Added

- The manifest editor and the Create screen check a manifest as you type against the schema the
  cluster publishes for its kind, custom resources included: a wrong type, a value a field does not
  allow and a missing required field are marked where they are, and a field the kind does not have
  is flagged with the one it was probably meant to be.
- The manifest editor completes field names and allowed values from the same schema, required fields
  first, and shows a field's type and description when you hover its name.

## [0.6.0] - 2026-09-24

### Changed

- Settings are kept in `~/.config/kubermeister/settings.json` on every operating system, a file you
  can write by hand, keep with your dotfiles and provision onto a machine: every key is optional, a
  change made in the app rewrites only that key, and the settings you already have are carried over
  on the first launch.
- A settings file that is not valid JSON, or holds a value Kubermeister refuses, is no longer reset
  to the defaults and overwritten: Settings names every value it did not use and why, and a file it
  cannot read is left untouched while the top bar says so.
- An edit to `settings.json` takes effect while Kubermeister runs, within a second of being saved,
  the same way a change made in Settings does.
- A published JSON Schema for `settings.json` gives editors completion, a description and the
  default of every key, and flags a value Kubermeister would refuse; a file the app creates points
  at it.

## [0.5.1] - 2026-09-23

### Fixed

- A pod's Logs and Shell tabs open on the container running the app instead of failing on an init
  container listed ahead of it. Logs can also read an init or ephemeral container, which the picker
  marks as such, and Shell no longer offers an init container, which has no process left to attach
  to.
- PersistentVolumes, StorageClasses, ClusterRoles and ClusterRoleBindings can no longer be deleted
  in bulk from their lists, where a plain confirmation skipped the typed name their single delete
  asks for. Their rows can still be checked and exported.
- A port forward started from a Service reaches its pods on the Service port's target port, where
  it went to the Service's own port number and failed whenever the two differed.
- Saving an autoscaler's bounds keeps every metric it watches. Changing only the replica range no
  longer rewrites its metrics, and changing the CPU target replaces that target alone, where either
  used to leave an autoscaler that also watched memory or a custom metric watching CPU only.
- A pod's shell knows the size of its terminal: it opens at the panel's size and follows it as the
  window or the layout changes, so full-screen programs such as `top` and `vi` draw for the space
  they have. The terminal used to tell the pod no size at all.

## [0.5.0] - 2026-09-22

### Added

- Quitting asks first, naming what it ends: every port forward, shell session, log follow and
  drain in progress goes with the app, and none of them come back. The dialog's Don't ask again and
  Settings › General turn it off.
- The rows checked on a list save to one YAML file, either as the cluster holds them or stripped of
  the fields the server owns so they can be applied to another cluster.
- The Create screen opens a manifest from a file, either through Import or by dropping the file
  anywhere on the window. The file is read by Kubermeister itself and lands in the editor, where it
  is applied the same way as one typed in.
- The Create screen starts a Job, a PersistentVolumeClaim, a ServiceAccount, a Role, a RoleBinding,
  a NetworkPolicy or a HorizontalPodAutoscaler, alongside the kinds it already offered.
- A Helm release's detail screen shows the objects a revision rendered, beside the values it was
  installed with.
- Help › Report a Bug… and a link on Settings › About open the bug report form with the version and
  the operating system already filled in.
- The update popover and Settings › About name the download size while an update comes down, so a
  differential update shows the few megabytes it is actually fetching rather than a bare percentage.
- Every release carries a `SHA256SUMS` file, so a download can be checked before it is run.
- Cluster calls go through your proxy. `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` are read the way
  kubectl reads them, from your login shell as well as the window's own environment, so an app
  started from the Dock reaches what a terminal reaches; Settings › Connection can name a proxy
  instead, exclude hosts from it, or turn it off.
- Settings › Connection can point at a CA bundle, for a cluster or an inspecting proxy whose
  certificate authority the system does not already trust. Those certificates are added to the ones
  already trusted, never put in their place.
- Settings holds the chart repositories and OCI registries Kubermeister reads charts from. Each one
  is read when it is added and again whenever you refresh it, its index is cached on disk, and any
  username and password go into this system's keychain rather than the settings file.

### Changed

- The manifest editor has Review changes beside Save: it shows what the save will change — the
  lines it removes and the lines it adds, against the object as it stands — with Save on that view,
  so a replace that carries the whole object can be read before it is written rather than after.
  Save itself still writes in one press.
- A new version is now downloaded in the background and installed the next time the app quits,
  rather than waiting behind a button nobody had a reason to press. Settings › Updates still offers
  being asked before anything is downloaded, or never checking at all. An install set to never
  check keeps that; one set to be asked moves to the new default, because earlier versions saved
  being asked whether or not anyone had chosen it.

### Fixed

- The window no longer sits on screen empty and white while Kubermeister closes; it goes when
  quitting is confirmed.
- A cluster call that runs past the read timeout is cancelled instead of left running. A screen
  waiting on a slow or unresponsive cluster no longer leaves a request open on every refresh, and
  the credential plugin a call started — an SSO login waiting on a browser, say — is ended with it
  rather than piling up one process per retry.
- A container's log reads as the container wrote it. Every line used to be prefixed with a level
  the app worked out from the text, which repeated the level most services already print, and
  invented one for the lines that print none.
- The Linux AppImage starts on Ubuntu 23.10 and newer. It was built on a runtime that loads
  libfuse2, which those releases no longer ship, so it failed at launch until that library was
  installed by hand.
- A Linux install from the .deb package is told when a new version is released. It still never
  installs one itself, since the package belongs to the system, but it names the version and links
  to the page to get it from.

## [0.4.9] - 2026-09-21

### Fixed

- On Linux the window, the dock and the application switcher show Kubermeister's icon rather than
  the desktop's generic placeholder.

## [0.4.8] - 2026-09-21

### Added

- The Logs tab opens already following, on the newest lines, rather than waiting for **Live**.
- The log console's **View** menu holds how lines are read: whether they wrap, whether each one
  carries its timestamp, and how many lines of tail to read.
- The log search can highlight its matches where they sit and keep every line, for the lines
  around a match that explain it, instead of hiding every line it misses.

### Fixed

- The log console follows the newest line as it arrives and hands the view back the moment you
  scroll up to read; it used to stay where it opened while lines piled up below.
- A workload's Logs tab shows each pod's whole name, where the column cut off exactly the suffix
  that tells one pod from another.

## [0.4.7] - 2026-09-20

### Fixed

- The cluster summary's events and alerts share the space below the health chart and scroll on
  their own, so the newest events stay in view without scrolling the page.

## [0.4.6] - 2026-09-20

### Added

- A Secret's **Keys** tab reveals one value when asked and masks it again after 30 seconds, and
  copies a value to the clipboard without ever showing it.

### Changed

- The update popover, the toast and Settings no longer print a release's notes, which are a long
  list of pull requests; they link to the release page, and the native update dialog offers a
  **Release Notes** button.

## [0.4.5] - 2026-09-20

### Added

- How often Kubermeister checks for updates is a setting: every hour, every 4 hours (the default),
  every 12 hours or once a day.

## [0.4.4] - 2026-09-20

### Changed

- A kubeconfig that will not load no longer stops the app at an error card: the window opens as
  usual and the top bar says what is wrong, with ways to try again, choose another kubeconfig or go
  back to the default.

### Fixed

- **Check for Updates…** in the menu works even when the window has not loaded, answering in
  native dialogs and downloading and installing from there.
- A context whose cluster or user entry is missing from the kubeconfig is named as the problem, and
  marked in the context selector, where every screen said "Something went wrong".

## [0.4.3] - 2026-09-18

### Fixed

- A kubeconfig with an entry that names no cluster, no user or no name at all loads the way kubectl
  loads it, with that entry left out, instead of failing as a whole and taking every working
  context with it.
- A credential plugin named by bare command, as `aws eks update-kubeconfig` writes it, is found
  when Kubermeister is started from the Finder or the Dock, and a plugin that is missing or fails
  says so by name instead of "Something went wrong".

## [0.4.2] - 2026-09-18

### Fixed

- The update popover shows a release's notes as text rather than raw HTML.

## [0.4.1] - 2026-09-18

### Added

- How long a cluster read may take is a setting, 60 seconds by default where it was a fixed 15,
  for clusters that need longer to list.

### Removed

- The Namespaces and Nodes lists no longer show pod counts, and the cluster summary no longer
  totals pods. Each count listed every pod in the cluster on every refresh, which made large
  clusters slow and look unreachable.

### Fixed

- A cluster that cannot be reached reads as unreachable rather than "Something went wrong", and one
  that is only slow says it timed out and points at the setting.
- A list that times out under **All namespaces** suggests choosing one namespace.

## [0.4.0] - 2026-09-18

### Changed

- A new icon: a ship's wheel, with its king spoke marked.

### Removed

- The disabled **Deploy** button on the cluster summary.

### Fixed

- Changing namespace closes the detail page of an object in the namespace just left, as switching
  context already did.
- The namespace selector shows that it is loading instead of offering **All namespaces** alone.
- Lists empty and reload the moment the namespace switches, rather than showing the previous
  namespace's rows for seconds.

## [0.3.0] - 2026-09-17

### Added

- A new version is announced in a toast and a badge in the top bar, with one click to download it,
  restart into it, or try again, and a setting to say whether it downloads by itself.
- Deployments, StatefulSets and DaemonSets restart from their detail screen.
- A Deployment rolls back to an earlier revision, pauses and resumes a rollout, shows one in
  progress, and compares two revisions side by side.
- Nodes cordon, uncordon and drain. The drain dialog shows what it will evict first, and the drain
  respects PodDisruptionBudgets and reports each pod as it goes.
- A Helm release rolls back or uninstalls, and stays a release the Helm CLI can read.
- A Job runs again, a CronJob runs now or has its schedule suspended and resumed, and a pod can be
  evicted or deleted without waiting.
- A pod links to the workload that runs it, and a workload lists the pods it owns.
- A pod's containers are listed with their part, init, app or ephemeral, and each one's usage beside
  what it requested.
- **Describe** gives pods and nodes the reading `kubectl describe` does, with copy and download.
- The log console searches by text or by pattern, with case sensitivity, reads a chosen container
  and time window, and keeps up to 50,000 lines, set in Settings, while drawing only those in view.
- A workload's **Logs** tab follows all of its pods at once, each coloured by pod.
- Port forwards keep running when you leave the page that started them, are listed and stopped from
  the top bar, can target a Service and survive its rollout, and are offered again per context.
- ReplicaSets, ReplicationControllers, PodDisruptionBudgets, PriorityClasses, Leases,
  RuntimeClasses, IngressClasses, the CSI kinds, webhook configurations,
  ValidatingAdmissionPolicies, APIServices and FlowSchemas have lists and detail screens.
- The instances of any custom resource definition are listed, with the columns the definition
  declares.
- A namespace has a screen of its own: what lives in it, its quotas and limits, and what its pods
  use against what they asked for. The Pods list groups by node or by workload.
- Every detail screen names the controlling owner and any finalizers holding a deletion open.
- **Related** shows what else an object is tied to, and why.
- Each list remembers which columns you chose.

### Changed

- Screens watching the same list share one watch, and lists draw only the rows in view, so large
  lists stay fast.

### Fixed

- Switching context ends every port forward, shell and log follow, which could otherwise carry on
  into the new cluster, and a write refuses to act on anything but the cluster and namespace on
  screen.

## [0.2.0] - 2026-09-16

### Added

- The first release that works with a cluster. Kubermeister reads your kubeconfig without changing
  it, and switches context and namespace from the top bar or the command palette (`⌘K` or `Ctrl+K`).
- A cluster dashboard with CPU and memory charts from metrics-server, alerts and recent events.
- Lists and detail screens, kept live, for nodes, namespaces, events, quotas and limit ranges; pods,
  Deployments, StatefulSets, DaemonSets, Jobs, CronJobs and HorizontalPodAutoscalers; Services,
  Ingresses, Endpoints and NetworkPolicies; PersistentVolumes, PersistentVolumeClaims,
  StorageClasses and VolumeSnapshots; ConfigMaps, and Secrets with their values masked;
  ServiceAccounts, Roles, ClusterRoles and their bindings; CustomResourceDefinitions and Helm
  releases.
- A pod's logs followed live, a shell into its containers, and port forwards to it.
- CPU and memory usage on the pod and node lists.
- A **Manifest** tab on every detail screen shows the object as the cluster holds it, with download.
- Objects can be created, edited, deleted and scaled.
- Settings, and light and dark themes.
- The window reopens where it was closed.

## [0.1.1] - 2026-09-15

### Added

- The first release: the application window, packaged for macOS, Windows and Linux, updating
  itself in the background and installing a new version when it quits.

[Unreleased]: https://github.com/kubermeister/kubermeister/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/kubermeister/kubermeister/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/kubermeister/kubermeister/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/kubermeister/kubermeister/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/kubermeister/kubermeister/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/kubermeister/kubermeister/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/kubermeister/kubermeister/compare/v0.4.9...v0.5.0
[0.4.9]: https://github.com/kubermeister/kubermeister/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/kubermeister/kubermeister/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/kubermeister/kubermeister/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/kubermeister/kubermeister/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/kubermeister/kubermeister/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/kubermeister/kubermeister/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/kubermeister/kubermeister/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/kubermeister/kubermeister/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/kubermeister/kubermeister/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/kubermeister/kubermeister/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/kubermeister/kubermeister/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kubermeister/kubermeister/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/kubermeister/kubermeister/releases/tag/v0.1.1
