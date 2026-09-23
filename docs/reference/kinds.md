---
title: Supported resource kinds
description: The Kubernetes resource kinds Kubermeister shows, where each one sits in the sidebar, and which have only a list screen.
sidebar:
  order: 5
---

Every kind below has a list screen, and every one but three has a detail screen for each object.
The tables follow the sidebar: the second column is where the kind's list lives and what the
sidebar calls it. Custom resources are handled separately — see
[custom resources](/docs/browse/custom-resources/).

## List only

Three kinds are shown as lists with no detail page behind their rows:

| Kind          | Sidebar                      |
| ------------- | ---------------------------- |
| ResourceQuota | **Overview › Quotas**        |
| LimitRange    | **Overview › Limits**        |
| Event         | **Overview › Events stream** |

Quotas and limit ranges flatten to one row per resource, grouped by namespace, rather than one row
per object with a nested table. An object's own events are on its detail page's **Events** tab.

## Overview

| Kind          | Sidebar                         |
| ------------- | ------------------------------- |
| Node          | **Overview › Nodes**            |
| Namespace     | **Overview › Namespaces**       |
| PriorityClass | **Overview › Priority Classes** |
| Lease         | **Overview › Leases**           |
| RuntimeClass  | **Overview › Runtime Classes**  |

**Overview › Cluster summary** is not a kind but the screen the app opens on.

Namespaces and Nodes are manifest kinds too, so they are read, edited and deleted through the
ordinary write path, and both ask you to type the name before deleting. The Namespaces list has a
**New namespace** button, which creates one through the same path.

## Workloads

| Kind                    | Sidebar                                 |
| ----------------------- | --------------------------------------- |
| Pod                     | **Workloads › Pods**                    |
| Deployment              | **Workloads › Deployments**             |
| StatefulSet             | **Workloads › Stateful Sets**           |
| DaemonSet               | **Workloads › Daemon Sets**             |
| ReplicaSet              | **Workloads › Replica Sets**            |
| ReplicationController   | **Workloads › Replication Controllers** |
| Job                     | **Workloads › Jobs**                    |
| CronJob                 | **Workloads › Cron Jobs**               |
| ConfigMap               | **Workloads › Config Maps**             |
| Secret                  | **Workloads › Secrets**                 |
| HorizontalPodAutoscaler | **Workloads › Autoscalers**             |
| PodDisruptionBudget     | **Workloads › Disruption Budgets**      |

ReplicaSets and ReplicationControllers list as their own kinds, each row naming the controller above
it in an **Owner** column — the only way to tell two rollouts of one deployment apart.

A PodDisruptionBudget allowing no disruption reads **Blocked**, since a drain stops on it and no
count says so on its own.

## Network

| Kind          | Sidebar                        |
| ------------- | ------------------------------ |
| Service       | **Network › Services**         |
| Ingress       | **Network › Ingresses**        |
| Endpoints     | **Network › Endpoints**        |
| IngressClass  | **Network › Ingress Classes**  |
| NetworkPolicy | **Network › Network Policies** |

## Storage

| Kind                  | Sidebar                        |
| --------------------- | ------------------------------ |
| PersistentVolume      | **Storage › Volumes**          |
| PersistentVolumeClaim | **Storage › Claims**           |
| StorageClass          | **Storage › Storage Classes**  |
| VolumeSnapshot        | **Storage › Snapshots**        |
| CSIDriver             | **Storage › CSI Drivers**      |
| CSINode               | **Storage › CSI Nodes**        |
| CSIStorageCapacity    | **Storage › Storage Capacity** |

VolumeSnapshots come from a CRD a cluster need not have, so their list is polled rather than
watched.

A CSIDriver's `attachRequired` defaults to **true** when unset, unlike its other flags — so an
omitted spec does not read as a driver that needs no attach step.

## Access

| Kind               | Sidebar                            |
| ------------------ | ---------------------------------- |
| ServiceAccount     | **Access › Service Accounts**      |
| Role               | **Access › Roles**                 |
| RoleBinding        | **Access › Role Bindings**         |
| ClusterRole        | **Access › Cluster Roles**         |
| ClusterRoleBinding | **Access › Cluster Role Bindings** |

## Add-ons

| Kind                           | Sidebar                           |
| ------------------------------ | --------------------------------- |
| CustomResourceDefinition       | **Add-ons › CRDs**                |
| MutatingWebhookConfiguration   | **Add-ons › Mutating Webhooks**   |
| ValidatingWebhookConfiguration | **Add-ons › Validating Webhooks** |
| ValidatingAdmissionPolicy      | **Add-ons › Admission Policies**  |
| APIService                     | **Add-ons › API Services**        |
| FlowSchema                     | **Add-ons › Flow Schemas**        |

A webhook configuration reads **Blocking** when any of its webhooks fails closed — which is the API's
own default when `failurePolicy` is unset — because such a configuration is a dependency of writing
at all. An unavailable APIService explains why a whole API group's kinds have vanished.

A CRD's instances are reached from its detail page, through **View instances**.

## Helm

**Add-ons › Releases** lists Helm releases, which are decoded from the Secrets Helm stores rather
than being a kind of their own; each opens on its revisions, values and manifest. **Add-ons › Helm
charts** lists the charts those releases were installed from, with no detail page. See
[Helm releases](/docs/operations/helm/).
