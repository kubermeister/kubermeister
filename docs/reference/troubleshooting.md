---
title: Troubleshooting
description: Fixing Kubermeister connection problems — kubeconfig errors, unusable contexts, credential plugin failures, timeouts, certificate trouble behind a proxy, empty list screens, and how to report a bug.
sidebar:
  order: 4
---

## The top bar says "Kubeconfig not loaded"

The kubeconfig did not load. The app still opens; open the notice to see why:

- `No file exists at <path>.` — the file you chose in Settings has moved or gone.
- `<path> could not be parsed as a kubeconfig file.` — the file you chose is not a kubeconfig.
- `The default kubeconfig ($KUBECONFIG or ~/.kube/config) could not be parsed.`

The notice offers **Try again** and **Choose kubeconfig…**, and **Use default kubeconfig** when you
had chosen a file of your own. When it is the default kubeconfig that will not parse, fix it on disk
and press **Try again**.

Individually broken entries are dropped rather than failing the whole file, so if the whole file is
refused, the problem is structural. The parser's own message quotes the file, so it is not shown; run
`kubectl config view` against the same file to see where it fails.

## The top bar says "Context unusable"

The file parsed, but the current context points at a cluster or user entry that is not there —
dropped as broken, or removed while the context stayed behind.

The notice names the missing entry, and the context selector strikes the context through. Switch to
a context that is complete, or repair the file.

## The top bar says "CA bundle unreadable"

The CA bundle chosen in **Settings › Connection › Certificate authority** has moved, cannot be read,
or holds no PEM certificate. Until it is fixed the app connects as if no bundle were set. Choose the
file again or **Clear** it in Settings, then press **Try again** on the notice.

## "Not authenticated", naming a credential plugin

Your kubeconfig authenticates through an exec credential plugin — `aws`, `gke-gcloud-auth-plugin`,
`kubelogin` — and it could not run. The detail says which:

- `The credential plugin "aws" was not found on the app's PATH.`
- `The credential plugin "aws" failed:` followed by the first line the plugin printed.

On macOS and Linux the app adopts your **login shell's** PATH at startup, so a plugin that works in
your terminal normally works here too. If it does not:

1. Check the plugin runs in a new terminal window, not just in the one where you changed PATH.
2. Check your shell profile finishes quickly. One that takes more than 5 seconds is abandoned, and
   the app keeps the bare environment it was launched with.
3. Check it is installed for the user running the app.
4. If you installed it after launching the app, restart the app so it asks the shell again.

On Windows the shell is not asked: the plugin has to be on the PATH the app was started with.

## Everything times out

Cluster reads have a ceiling, 60 seconds by default, in **Settings › General › Cluster reads ›
Read timeout**. A timed-out list reads **Cluster timed out** and links to Settings, because how long
your cluster may take is your call.

A server that cannot be reached at all — the VPN is down, the address does not resolve, the
connection is refused — is reported as **Cluster unreachable** instead, and arrives sooner: the
connection attempt gives up after 10 seconds. That distinction usually tells you whether the cluster
is slow or simply not there.

## A namespaced list times out under All namespaces

Under **All namespaces**, the cluster is asked for that kind in every namespace at once. Pick a
namespace from the selector. The app suggests exactly this when it happens, and cluster-scoped
screens never do, because narrowing does not apply to them.

## A list is empty but kubectl shows rows

Check the namespace selector first — a list asks for its kind _in its namespace_, and the search box
only narrows what is already there.

If the kind is a custom resource, check that the definition is served and that its instances are in
the namespace you are looking at.

## Behind a proxy, nothing connects

See [proxies and certificates](/docs/clusters/proxies-and-certificates/). The short version: a
kubeconfig's `proxy-url` always wins for that cluster; after that, **Settings › Connection ›
Proxy** decides, and under **Follow the environment** `HTTPS_PROXY` and `HTTP_PROXY` are read per
scheme with no cross-scheme fallback. Loopback is never proxied.

## A private cluster reads "Cluster unreachable"

A certificate the app does not trust is reported as **Cluster unreachable**, not as a certificate
error, so an unreachable cluster that `kubectl` reaches fine is often a trust problem. That happens
with a private authority the kubeconfig does not carry, or a proxy that inspects traffic. Add the
authority's PEM file under **Settings › Connection › Certificate authority**; it is added to what
is already trusted.

## A shell, forward or log follow ended on its own

Every stream shares one live connection, and these end them all:

- switching context, which also closes an open detail page and removes every port forward from the
  top bar;
- choosing or resetting the kubeconfig, or changing the proxy or CA bundle — an open shell prints the
  reason and `[session ended]`;
- reloading the window (**View › Reload**, `⌘R` or `Ctrl+R`).

Nothing reconnects by itself. Open the tab again, or start the forward again from the top bar, where
the forwards you have used on this context are offered.

## Still stuck

**Help › Report a Bug…**, or **Report a bug** in **Settings › Updates › About**, opens the bug report
form on GitHub with the version already filled in, and the operating system on macOS and Windows.
Issues are at
[github.com/kubermeister/kubermeister/issues](https://github.com/kubermeister/kubermeister/issues),
and questions go to [Discussions](https://github.com/kubermeister/kubermeister/discussions).
