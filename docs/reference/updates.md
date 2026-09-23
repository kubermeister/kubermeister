---
title: Updates
description: How Kubermeister finds and installs new versions — the three update modes, the check interval, the top-bar pill, the menu's Check for Updates dialog, and why a .deb install does not update itself.
sidebar:
  order: 3
---

Kubermeister checks its GitHub releases for new versions. On macOS, Windows and the Linux AppImage
it can download and install one itself. A `.deb` install cannot: see [the .deb](#the-deb).

## Modes

Set in **Settings › Updates › Automatic updates**, under **When a new version is found**:

- **Download in the background** (the default) — a version that is found downloads straight away and
  installs when you quit. You are not asked first; the pill goes straight to **Downloading**.
- **Notify me and let me choose** — you are told a version exists, and it downloads when you press
  **Update**.
- **Never check automatically** — no scheduled checks. A check you start from Settings, the menu or
  the command palette still runs.

The download default is deliberate. The app releases often and installs on quit, so a version
waiting on a click is a fix that never lands.

Nothing downloads on its own before the mode is read, and the mode is read at the moment a version is
found, so choosing **Notify me and let me choose** genuinely prevents the download rather than hiding
it, and a change takes effect without a restart.

A downloaded version installs the next time the app quits, or at once with **Restart now**.

## Scheduling

The first check runs 15 seconds after launch, then at the interval set under **Check for new
versions**: **Every hour**, **Every 4 hours** (the default), **Every 12 hours** or **Once a day**.
Changing the interval reschedules the next check from now; saving any _other_ setting never pushes
it out.

A scheduled check that fails is recorded quietly: it never becomes a notification or a pill. The
**About** card in Settings shows "Update check failed." with the reason, and you find out when you go
looking. A check you started yourself that fails does show, as **Update failed**.

## Where you see it

**The pill in the top bar** appears only when there is something to act on:

| Pill                  | Popover offers                                                    |
| --------------------- | ----------------------------------------------------------------- |
| **Update available**  | **Update** and **What's new**                                     |
| **Downloading N%**    | a progress bar, the size ("8.2 MB of 12.4 MB") and **What's new** |
| **Restart to update** | **Restart now** and **What's new**                                |
| **Update failed**     | **Try again** and **Dismiss**                                     |

The size shown while downloading is what this download fetches, which for a differential update is
the size of the change rather than of the installer.

**A toast** appears once per version when a version is found under **Notify me and let me choose**
(with **Update**) and when a download is ready (with **Restart**). Progress, errors and "up to date"
never toast.

**The About card** in **Settings › Updates** shows the same state in words, with **Check for
updates**, and **Download update** or **Restart now** when either applies.

**Check for updates** in the command palette runs a check and opens Settings, where the outcome
shows.

**Check for Updates…** in the menu — **Kubermeister › Check for Updates…** on macOS, **File › Check
for Updates…** on Windows and Linux — runs a check and answers in **native dialogs** rather than the
interface. The pill and Settings exist only once the window has finished loading; the menu still
works when it has not, so a broken install always has a way to the fix.

- A found version: **Download**, **Release Notes** and **Later**. After a download, you are asked
  again when it is ready.
- A downloaded version: **Restart Now** and **Later**, which installs it when you quit.
- Up to date, or a failure ("Kubermeister could not check for updates."): **OK**.

## The .deb

A `.deb` belongs to your package manager, and an app that overwrote its own files would leave the
package database describing something else. So a `.deb` install never downloads or installs a new
version. It reads the release feed to learn one exists, and then:

- the pill reads **Update available**, and its popover and the About card say "This package is
  managed by the system, so the new version is installed the same way as this one.";
- the one action is **Get the update**, which opens that version's release page, where you download
  the new `.deb` and install it as you did the first;
- the menu's dialog offers **Release Notes** and **OK**, with no **Download**.

The modes and the schedule apply as they do elsewhere; only the installing is left to you. The
AppImage is not affected, and updates itself.

## Release notes

The app shows none. Generated release notes are a list of pull-request titles, too long for a popover
and already rendered properly on the release page — so the app gives the version and its date, and
**What's new** and the dialog's **Release Notes** open that version's release page in your browser.

What a release actually changed for you is in the [changelog](/changelog/), which is written by hand.

## Development builds

A build you run from source has no release feed to check against. Settings reads "In-app updates are
unavailable here." with "Development build", and the menu's dialog says "This build cannot check for
updates."
