---
title: Writing to the cluster
description: How Kubermeister makes writes to a Kubernetes cluster safe — context stamping, namespace rules, replaces that carry a resourceVersion, confirmations, the kinds that ask you to type their name, bulk delete, and how failures are reported.
sidebar:
  order: 4
---

Every write in the app — create, save, delete, scale, restart, rollback, cordon, drain and the rest —
goes through the same path and the same guards. There is no read-only mode or protected-context
setting; the guards below are what stand between a click and the cluster.

Creating an object and editing one in place are covered in
[manifests](/docs/browse/manifests/): the **Create resource** screen, templates, **Import**, the
editor, **Dry run** and **Review changes**. This page is about what every one of those writes has in
common.

## Writes fail closed on targeting

Every write carries a **context stamp**: the context the screen was rendered under. The app compares
it with the context it is actually on and refuses a mismatch as a conflict, naming the context the
action was meant for and the one the app is now on, and asking you to reload the screen and try
again.

That is what makes a stale tab safe. Rows left over from before a context switch cannot act on the
new cluster, no matter how long the window sat open.

## Namespace rules

- A delete, scale or restart of a namespaced kind **must** name its namespace; a cluster-scoped kind
  must not.
- **The active namespace is never consulted for a destructive write.** A screen can only act on the
  object it displayed.
- A create or replace whose manifest names no namespace takes the active one — and with **All
  namespaces** selected, is refused rather than guessed at: "… needs a namespace: select one or add
  metadata.namespace." A cluster-scoped kind never gets a namespace, even if the manifest gives it
  one; for a custom resource the app asks the API server which it is.
- Single-object reads follow the same rule: with no namespace named and none selected, you get "not
  found", never the first same-named object found across the cluster.

## Replaces carry their resourceVersion

Saving an edited object is a **replace**, not a patch, and the manifest must carry the
`metadata.resourceVersion` it was read with ("The manifest must carry metadata.resourceVersion.
Reload the object before saving."). If somebody else changed the object in the meantime, the API
server rejects the save as a conflict — never a silent overwrite — and the editor offers **Reload
latest**, which keeps your edits and takes the new version.

A save must also still describe the object the editor was opened on. Change the kind, name or
namespace and it is refused: "Restore the kind, name and namespace, or use Create resource for a new
object."

Scaling works the same way: the scale subresource is read and written back with its
`resourceVersion`, so a concurrent change is rejected rather than lost.

## Confirmations

Most writes that remove or replace something ask first, naming exactly what will be affected:

- **Delete** (the trash icon in a detail page's header) asks "Delete _Kind_?" and says it cannot be
  undone. After it succeeds you land back on the kind's list, where the object may linger while the
  cluster finishes with it. On a pod the dialog adds **Delete without waiting**.
- **Restart**, **Roll back**, **Run again**, **Evict**, **Drain**, **Uninstall** and a release's
  **Roll back** each have their own dialog.
- A few writes are one click, because they are easy to reverse: scaling by a step, **Pause** and
  **Resume** on a Deployment, **Cordon** and **Uncordon**, **Suspend** and **Resume** on a CronJob,
  **Run now**, and the **Restart** on a pod's Overview, which rolls its owning workload.

## Kinds that ask you to type the name

Deleting one of these kinds reaches far beyond the object itself, so the dialog asks you to type the
object's name before **Delete** unlocks, and says what goes with it:

| Kind                     | What the dialog adds                                                  |
| ------------------------ | --------------------------------------------------------------------- |
| Node                     | Every pod scheduled on it is lost.                                    |
| Namespace                | No note, though a namespace takes every object inside it with it.     |
| CustomResourceDefinition | Every custom resource of this type in the cluster is deleted with it. |
| PersistentVolume         | The data it backs may become unreachable.                             |
| StorageClass             | Claims that name it can no longer be provisioned.                     |
| ClusterRole              | Every binding that grants it stops granting anything.                 |
| ClusterRoleBinding       | Its subjects lose the role everywhere in the cluster.                 |

## Bulk delete

Most lists have a checkbox column. Checking rows brings up a bar above the list with **N selected**,
**Clear**, **Export N** (see [lists](/docs/browse/lists/)) and **Delete N**. The selection is exactly
the checked rows that the current search shows.

**Delete N** asks "Delete _N kinds_?", naming up to eight of them and counting the rest. The deletes
then run four at a time, each on its own, so one failure does not stop the others. The result is one
toast — "_N kinds_ deleted", or "_N kinds_ deleted, _M_ failed" with the reason for each failure — and
the rows that failed stay selected, so a retry starts from exactly those.

The Nodes, Namespaces and CustomResourceDefinitions lists have no checkbox column, so those kinds can
only be deleted one at a time, by name.

:::caution[Known issue]
PersistentVolumes, StorageClasses, ClusterRoles and ClusterRoleBindings **can** be bulk deleted, and
**Delete N** does not ask you to type any names, unlike their single delete. Check the selection
before you confirm. ([#336](https://github.com/kubermeister/kubermeister/issues/336))
:::

## Errors

A failed write is reported as a toast whose title names the kind of failure and whose description
carries the API server's own reason:

| Title                 | What it means                                                                       |
| --------------------- | ----------------------------------------------------------------------------------- |
| Kubeconfig not loaded | The kubeconfig file would not load; nothing reaches a cluster until it is fixed.    |
| Cluster unreachable   | The connection never came up: refused, DNS, TLS, or a connect timeout.              |
| Cluster timed out     | The API server was reached but did not finish answering within the read timeout.    |
| Access denied         | Forbidden (403): your RBAC does not allow it.                                       |
| Not authenticated     | Unauthorised (401): the credentials were not accepted.                              |
| Not found             | The object or API does not exist (404).                                             |
| Conflict              | 409: the object already exists or changed since it was read, or a context mismatch. |
| Invalid manifest      | The app or the API server (400, 422) rejected the input.                            |
| Something went wrong  | Anything else.                                                                      |
