# Changelog

What changed in each release, written for somebody deciding whether to update. It is kept by hand:
the release notes on GitHub already list every pull request, and a second copy of that list would
say no more than the first. A line here is about the app, not about the change — what it now does,
or what stopped going wrong — and work nobody outside the repository would notice is left out.

This file starts at the version below. Releases before it are described on the
[releases page](https://github.com/kubermeister/kubermeister/releases).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Settings are kept in `~/.config/kubermeister/settings.json` on every operating system, a file you
  can write by hand, keep with your dotfiles and provision onto a machine: every key is optional, a
  change made in the app rewrites only that key, and the settings you already have are carried over
  on the first launch.

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
