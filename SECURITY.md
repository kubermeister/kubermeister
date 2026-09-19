# Security policy

Kubermeister holds cluster credentials, opens shells into pods and writes to the API server on the
user's behalf. A vulnerability in it is a vulnerability in every cluster it is pointed at, so
reports are taken seriously and handled privately.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it through
[GitHub's private vulnerability reporting](https://github.com/kubermeister/kubermeister/security/advisories/new).
Only the maintainer sees the report. Include what you found, how to reproduce it, and what an
attacker could do with it. A proof of concept against a disposable cluster is welcome; one against
a cluster you do not own is not.

You will get an acknowledgement within a week. Once the problem is confirmed, a fix ships in a new
release, the advisory is published with credit to the reporter unless they prefer otherwise, and the
report is closed.

## What counts

Anything that lets the app do something the user did not ask for or see, for example:

- reaching a cluster or namespace other than the one the screen shows;
- writing to the cluster without the confirmation the screen promises;
- reading or exposing Secret values outside the manifest view;
- escaping the renderer sandbox, or reaching Node.js or the file system from renderer code;
- sending kubeconfig contents, tokens or cluster data anywhere but the API server they belong to;
- weaknesses in the update mechanism or the release pipeline.

Denial of service against the app itself by a hostile cluster is worth a report too, though it is
lower priority than anything that crosses a boundary.

## Supported versions

Fixes go into the latest release. Older releases are not patched;
the in-app updater and Homebrew make moving to the latest release a one-step operation.

## Design notes

The [How it works](README.md#how-it-works) section of the README describes the boundaries the app
is built around: the sandboxed renderer, the validated message bridge, the read-only kubeconfig,
writes that fail closed on the connection they were meant for, and the absence of any agent or
privileged pod in the cluster. A report showing one of those boundaries does not hold is exactly
what this policy is for.
