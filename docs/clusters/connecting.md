---
title: Connecting to a cluster
description: Which kubeconfig Kubermeister reads, how it authenticates with exec credential plugins for EKS, GKE and AKS, the checks it runs at startup, and what to do when a kubeconfig will not load.
sidebar:
  order: 1
---

Kubermeister reads your kubeconfig and treats it as **read-only**. Switching context or namespace in
the app changes the app's own memory and settings — never the file on disk. Nothing you do here will
surprise the `kubectl` in your terminal.

## Which kubeconfig it reads

By default, the same one `kubectl` does: the files named by `$KUBECONFIG`, or `~/.kube/config` when
it is unset. **Settings › Connection › Kubeconfig** shows the path in use, and reads
`$KUBECONFIG or ~/.kube/config (default)` until you choose another.

- **Browse…** picks a different file through a native dialog, titled "Choose a kubeconfig file". The
  app never takes a path typed into the interface.
- **Use default** goes back to `$KUBECONFIG` or `~/.kube/config`. It is available only while
  another file is chosen.

Either change ends every open port forward, shell, log follow and drain, and reloads the kubeconfig,
because every one of them was made over the old one.

With no default kubeconfig at all, the app still opens. The context selector reads **No cluster**
and nothing reports an error, since there is nothing to fix until you have a cluster to point at.

## Authentication

There is no dependency on `kubectl`. The client library runs exec credential plugins itself, so a
kubeconfig written by `aws eks update-kubeconfig`, `gcloud container clusters get-credentials` or
`az aks get-credentials` works as it does in a terminal.

Two details make that work outside a terminal:

- **Your login shell's PATH is adopted at startup** on macOS and Linux. An app launched from Finder,
  the Dock or a desktop menu otherwise inherits a bare `/usr/bin:/bin:/usr/sbin:/sbin`, and a
  kubeconfig that names its plugin by bare command — `aws`, `gke-gcloud-auth-plugin` — would not find
  it. The app asks your shell (`$SHELL -ilc`) once, puts the shell's PATH entries first and keeps the
  ones it already had. The proxy variables come across the same way, but only those the launch
  environment does not already set. A profile that takes longer than 5 seconds is abandoned, and
  the app carries on with the environment it was started with. Windows is not asked; there the app
  uses the environment it was launched with.
- **A failing plugin is named.** The error is titled **Not authenticated**, and its detail reads
  either `The credential plugin "aws" was not found on the app's PATH.` or
  `The credential plugin "aws" failed:` followed by the first line of what the plugin printed, cut at
  200 characters.

When a cluster call times out, the plugin process it started is killed with it, so an SSO login
waiting on a browser does not pile up one process per retry.

## Startup checks

At launch the app runs four checks, in order. A check whose precondition failed is reported as
skipped rather than run into the same failure.

| Check                      | Fails when                                                                    |
| -------------------------- | ----------------------------------------------------------------------------- |
| **Kubeconfig file**        | the chosen file does not exist, or the kubeconfig does not parse              |
| **Proxy and certificates** | the CA bundle in Settings cannot be read or holds no certificate              |
| **Current context**        | the current context names a cluster or user the file does not define          |
| **Cluster connection**     | the API server does not answer a version request within 5 seconds (a warning) |

None of them keeps the window from opening. An unreachable cluster is only a warning, because the
context you are on may legitimately be offline and you can switch once inside. A kubeconfig with no
current context is a warning too: pick one from the context selector.

The same checks run again when you switch context, choose or reset the kubeconfig, or choose or
clear the CA bundle.

## When the kubeconfig will not load

A kubeconfig that will not parse never blocks the app. The window opens, every cluster screen reports
**Kubeconfig not loaded**, and the top bar carries a notice of the same name. Its popover says what
failed:

- `No file exists at <path>.` — the file you chose has gone.
- `<path> could not be parsed as a kubeconfig file.` — the file you chose is not a kubeconfig.
- `The default kubeconfig ($KUBECONFIG or ~/.kube/config) could not be parsed.`

The parser's own message is never shown, because it quotes part of the file.

The popover offers **Try again** and **Choose kubeconfig…**, and **Use default kubeconfig** when
you had chosen a file of your own. When the default kubeconfig is the broken one there is no other
default to fall back to, so the hint asks you to fix it on disk.

Entries that are individually broken, such as an entry missing the name or the `cluster:` that
identifies it, are dropped rather than failing the whole file, the same tolerance `kubectl` has.
Every other context in the file keeps working.

## When a context is unusable

A file can parse and still contain a context whose cluster or user entry is missing, because it was
dropped as broken or removed while the context stayed. The client library would switch to it and
then fail every call.

Kubermeister names the missing entry instead. In the context selector the context is struck
through, with a red dot and the line "Unusable: names a missing cluster or user". When it is the
current context, the top bar shows **Context unusable**, whose popover names the missing cluster or
user and suggests switching context or fixing the entry. Switching context re-runs the checks, so the
notice always describes where you are now.

## Read timeouts

Every cluster read has a ceiling, 60 seconds by default, set in **Settings › General › Cluster
reads › Read timeout** (15, 30, 60, 120 or 300 seconds). When a read hits it the app both reports
the timeout _and_ aborts the request, so a screen that polls cannot pile up requests and
credential-plugin processes against a cluster that never answers.

A timed-out list reads **Cluster timed out**, with "The cluster did not answer within 60 s. It may
be busy, or the connection slow." and a link to Settings to raise the ceiling, because how long your
cluster may take is your call, not the app's. A server that cannot be reached at all is reported sooner and differently, as
**Cluster unreachable** — see [troubleshooting](/docs/reference/troubleshooting/#everything-times-out).

## Next

[Contexts and namespaces](/docs/clusters/contexts-namespaces/) ·
[Proxies and certificates](/docs/clusters/proxies-and-certificates/)
