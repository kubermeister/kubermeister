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

### Added

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

- Saving an edited manifest shows what the save will change first — the lines it removes and the
  lines it adds, against the object as it stands — with Save on that view. A save replaces the
  whole object, so what a replace carries is now read before it is written rather than after.

- A new version is now downloaded in the background and installed the next time the app quits,
  rather than waiting behind a button nobody had a reason to press. Settings › Updates still offers
  being asked before anything is downloaded, or never checking at all, and an install already set
  to one of those keeps it.

### Fixed

- A container's log reads as the container wrote it. Every line used to be prefixed with a level
  the app worked out from the text, which repeated the level most services already print, and
  invented one for the lines that print none.

- The Linux AppImage starts on Ubuntu 23.10 and newer. It was built on a runtime that loads
  libfuse2, which those releases no longer ship, so it failed at launch until that library was
  installed by hand.

- A Linux install from the .deb package is told when a new version is released. It still never
  installs one itself, since the package belongs to the system, but it names the version and links
  to the page to get it from.
