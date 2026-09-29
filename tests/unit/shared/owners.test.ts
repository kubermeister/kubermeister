import { describe, expect, it } from 'vitest';
import { ownedPodsInputSchema, ownerPath, restartableOwner } from '../../../src/shared/k8s/owners';

describe('owner links', () => {
    it('points at the screen for a kind the app shows, and nowhere for one it does not', () => {
        expect(ownerPath('apps/v1', 'Deployment', 'web', 'team-a')).toBe('/workloads/deployments/team-a/web');
        expect(ownerPath('batch/v1', 'Job', 'import', 'team-a')).toBe('/workloads/jobs/team-a/import');
        // Cluster-scoped kinds have no namespace in their route.
        expect(ownerPath('apiextensions.k8s.io/v1', 'CustomResourceDefinition', 'widgets.example.com', 'team-a')).toBe(
            '/addons/crds/widgets.example.com',
        );
        expect(ownerPath('apps/v1', 'ReplicaSet', 'web-abc', 'team-a')).toBe('/workloads/replicasets/team-a/web-abc');
        // An unknown kind never gets a path by guessing.
        expect(ownerPath('example.com/v1', 'Widget', 'thing', 'team-a')).toBeNull();
    });

    it('links a kind only in its own API group, never a custom kind that shares its name', () => {
        expect(ownerPath('batch.volcano.sh/v1alpha1', 'Job', 'train', 'team-a')).toBeNull();
        expect(ownerPath('apps.kruise.io/v1beta1', 'StatefulSet', 'db', 'team-a')).toBeNull();
        // Any served version of the right group still links.
        expect(ownerPath('batch/v1beta1', 'CronJob', 'nightly', 'team-a')).toBe('/workloads/cronjobs/team-a/nightly');
    });

    it('finds the owner a rollout restart would act on, and none for a job', () => {
        const rs = {
            apiVersion: 'apps/v1',
            kind: 'ReplicaSet',
            name: 'web-abc',
            namespace: 'team-a',
            path: '/workloads/replicasets/team-a/web-abc',
        };
        const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', namespace: 'team-a', path: '/x' };
        expect(restartableOwner([rs, deployment])).toBe(deployment);
        const job = { apiVersion: 'batch/v1', kind: 'Job', name: 'import', namespace: 'team-a', path: '/x' };
        expect(restartableOwner([job])).toBeUndefined();
        expect(restartableOwner([])).toBeUndefined();
    });

    it('never offers to restart a custom workload named like a built-in one', () => {
        // A restart would patch the apps/v1 StatefulSet of the same name: a 404, or somebody else's.
        const kruise = {
            apiVersion: 'apps.kruise.io/v1beta1',
            kind: 'StatefulSet',
            name: 'db',
            namespace: 'team-a',
            path: null,
        };
        expect(restartableOwner([kruise])).toBeUndefined();
    });

    it('takes only the kinds that own pods', () => {
        const input = { name: 'web', namespace: 'team-a' };
        expect(ownedPodsInputSchema.safeParse({ ...input, kind: 'Deployment' }).success).toBe(true);
        expect(ownedPodsInputSchema.safeParse({ ...input, kind: 'CronJob' }).success).toBe(true);
        expect(ownedPodsInputSchema.safeParse({ ...input, kind: 'ConfigMap' }).success).toBe(false);
        expect(ownedPodsInputSchema.safeParse({ kind: 'Deployment', name: 'web' }).success).toBe(false);
    });
});
