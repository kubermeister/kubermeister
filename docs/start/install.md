---
title: Install Kubermeister
description: Install the Kubermeister desktop Kubernetes client on macOS with Homebrew or the .dmg, on Windows with the installer, and on Linux from the AppImage or .deb, and check a download against SHA256SUMS.
sidebar:
  order: 1
---

Kubermeister is a desktop application for macOS, Windows and Linux. Every build comes from a tagged
release on GitHub, and the installers carry the version in their file name, so a download is always
a specific release rather than whatever is current.

Only the macOS build is signed and notarised. The Windows and Linux installers are unsigned, so the
[checksum](#verifying-a-download) is how you tell a good download from a truncated or tampered one.

## macOS

### Homebrew

```sh
brew install --cask kubermeister/tap/kubermeister
```

The cask installs the same `.dmg` the download page offers. It declares `auto_updates true`, because
the app [updates itself](#updating) whichever way it was installed.

### The installer

Download the `.dmg` for your architecture from the [download page](/download/) — `mac-arm64` for
Apple silicon, `mac-x64` for Intel — open it and drag the app to Applications.

The macOS build is Developer ID signed and notarised, so the first launch opens without a
right-click-to-open dance.

## Windows

Download the `.exe` installer (`win-x64`) from the [download page](/download/) and run it. The
installer is not code-signed; check it against `SHA256SUMS` before you run it.

## Linux

Two formats are published, both x86-64:

- **AppImage** — download it, mark it executable and run it. Nothing is installed, and it needs no
  FUSE library.

  ```sh
  chmod +x Kubermeister-*-linux-x86_64.AppImage
  ./Kubermeister-*-linux-x86_64.AppImage
  ```

- **`.deb`** — for Debian, Ubuntu and derivatives.

  ```sh
  sudo apt install ./Kubermeister-*-linux-amd64.deb
  ```

The two update differently. The AppImage updates itself like the other builds. A `.deb` belongs to
your package manager, so the app only tells you a new version exists and links to its release
page; you install the new `.deb` the same way you installed this one.

An AppImage installs no desktop entry until you integrate it, so on Linux the window sets its own
icon rather than relying on one to supply it.

## Verifying a download

Every release carries a `SHA256SUMS` file beside its installers, listing the SHA-256 digest of each
`.dmg`, `.zip`, `.exe`, `.AppImage` and `.deb`. Download it from the
[releases page](https://github.com/kubermeister/kubermeister/releases) into the same folder as the
installer and check it:

```sh
# Linux
sha256sum --check --ignore-missing SHA256SUMS

# macOS
shasum -a 256 --check --ignore-missing SHA256SUMS
```

On Windows, compare the output of `Get-FileHash .\Kubermeister-*-win-x64.exe` in PowerShell with the
line for that file.

The release is made public only after `SHA256SUMS` is attached, so it is never visible without its
checksums. Before that, each installer is uploaded on its own and read back to compare its size and
digest with the file that was built, and the update feed a running app reads is written last, so it
only ever names files that are complete.

## Updating

Kubermeister checks its GitHub releases for a new version. By default it downloads one in the
background and installs it when you quit. You can have it ask first, or stop checking on a
schedule — see [updates](/docs/reference/updates/). A `.deb` install is the exception: it reports
the new version and leaves the installing to you.

## Next

Point it at a cluster: [connecting to a cluster](/docs/clusters/connecting/).
