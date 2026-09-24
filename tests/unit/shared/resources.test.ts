import { describe, expect, it } from 'vitest';
import {
    apiGroupOf,
    KIND_REGISTRY,
    KINDS,
    kindInfo,
    kindSchema,
    registeredKindOf,
} from '../../../src/shared/k8s/registry';
import {
    resourceGetInputSchema,
    resourceGetOutputSchema,
    resourceListInputSchema,
    resourceListOutputSchema,
} from '../../../src/shared/k8s/resources';

const podRow = {
    name: 'web-1',
    namespace: 'team-a',
    status: 'Running',
    ready: '1/1',
    restarts: 0,
    age: '3d',
    node: 'n1',
    owner: 'ReplicaSet/web-7d9',
    cpu: 0,
    mem: 0,
    cpuLimit: 500,
    memLimit: 128,
};

describe('kind registry', () => {
    it('knows every kind with its API facts and list path', () => {
        expect(KINDS).toEqual([
            'Pod',
            'Deployment',
            'StatefulSet',
            'DaemonSet',
            'ReplicaSet',
            'ReplicationController',
            'Job',
            'CronJob',
            'HorizontalPodAutoscaler',
            'PodDisruptionBudget',
            'PriorityClass',
            'Lease',
            'RuntimeClass',
            'ConfigMap',
            'Secret',
            'Service',
            'Ingress',
            'Endpoints',
            'NetworkPolicy',
            'IngressClass',
            'PersistentVolume',
            'PersistentVolumeClaim',
            'StorageClass',
            'VolumeSnapshot',
            'CSIDriver',
            'CSINode',
            'CSIStorageCapacity',
            'ServiceAccount',
            'Role',
            'RoleBinding',
            'ClusterRole',
            'ClusterRoleBinding',
            'MutatingWebhookConfiguration',
            'ValidatingWebhookConfiguration',
            'ValidatingAdmissionPolicy',
            'APIService',
            'FlowSchema',
            'CustomResourceDefinition',
        ]);
        expect(kindInfo('HorizontalPodAutoscaler')).toMatchObject({
            apiVersion: 'autoscaling/v2',
            listPath: '/workloads/autoscalers',
        });
        expect(kindInfo('Job').apiVersion).toBe('batch/v1');
        expect(kindInfo('Deployment')).toMatchObject({
            apiVersion: 'apps/v1',
            scalable: true,
            listPath: '/workloads/deployments',
        });
        expect(kindInfo('DaemonSet').scalable).toBe(false);
        expect(kindInfo('ClusterRole')).toMatchObject({
            apiVersion: 'rbac.authorization.k8s.io/v1',
            clusterScoped: true,
            listPath: '/access/clusterroles',
        });
        expect(kindInfo('Pod')).toEqual({
            kind: 'Pod',
            apiVersion: 'v1',
            clusterScoped: false,
            scalable: false,
            listPath: '/workloads/pods',
        });
        for (const info of Object.values(KIND_REGISTRY)) expect(info.listPath.startsWith('/')).toBe(true);
    });

    it('rejects unknown kinds at the schema boundary', () => {
        expect(kindSchema.safeParse('Pod').success).toBe(true);
        expect(kindSchema.safeParse('pod').success).toBe(false);
        expect(kindSchema.safeParse('Deployment').success).toBe(true);
        expect(kindSchema.safeParse('ReplicaSet').success).toBe(true);
        expect(kindSchema.safeParse('ReplicaSets').success).toBe(false);
    });

    it('names the API group of an apiVersion, the core group being empty', () => {
        expect(apiGroupOf('v1')).toBe('');
        expect(apiGroupOf('apps/v1')).toBe('apps');
        expect(apiGroupOf('rbac.authorization.k8s.io/v1')).toBe('rbac.authorization.k8s.io');
    });

    it('matches a manifest kind to the registry by group as well as by name, at any version', () => {
        expect(registeredKindOf('v1', 'Service')).toBe('Service');
        expect(registeredKindOf('apps/v1', 'Deployment')).toBe('Deployment');
        expect(registeredKindOf('apps/v1beta2', 'Deployment')).toBe('Deployment');
        expect(registeredKindOf('autoscaling/v1', 'HorizontalPodAutoscaler')).toBe('HorizontalPodAutoscaler');
        // A custom resource calling itself Service is not the core Service.
        expect(registeredKindOf('serving.knative.dev/v1', 'Service')).toBeUndefined();
        expect(registeredKindOf('messaging.example.com/v1', 'Queue')).toBeUndefined();
    });
});

describe('generic resource channels', () => {
    it('validates list and get inputs', () => {
        expect(resourceListInputSchema.safeParse({ kind: 'Pod' }).success).toBe(true);
        expect(resourceListInputSchema.safeParse({ kind: 'Pod', namespace: 'x' }).success).toBe(true);
        expect(resourceListInputSchema.safeParse({ kind: 'Nope' }).success).toBe(false);
        expect(resourceGetInputSchema.safeParse({ kind: 'Pod', name: 'web-1' }).success).toBe(true);
        expect(resourceGetInputSchema.safeParse({ kind: 'Pod', name: '' }).success).toBe(false);
    });

    it('discriminates outputs on kind', () => {
        expect(resourceListOutputSchema.safeParse({ kind: 'Pod', items: [podRow] }).success).toBe(true);
        expect(
            resourceListOutputSchema.safeParse({ kind: 'Pod', items: [{ ...podRow, status: 'Sleeping' }] }).success,
        ).toBe(false);
        expect(resourceGetOutputSchema.safeParse({ kind: 'Pod', item: null }).success).toBe(true);
        expect(resourceGetOutputSchema.safeParse({ kind: 'Node', item: null }).success).toBe(false);
        const jobRow = {
            name: 'j',
            namespace: 'a',
            completions: '1/1',
            duration: '1m0s',
            status: 'Complete',
            age: '1h',
        };
        expect(resourceListOutputSchema.safeParse({ kind: 'Job', items: [jobRow] }).success).toBe(true);
        expect(
            resourceListOutputSchema.safeParse({ kind: 'Job', items: [{ ...jobRow, status: 'Sleeping' }] }).success,
        ).toBe(false);
        expect(
            resourceGetOutputSchema.safeParse({ kind: 'Job', item: { ...jobRow, labels: [], annotations: [] } })
                .success,
        ).toBe(true);
        const cronRow = {
            name: 'c',
            namespace: 'a',
            schedule: '@daily',
            suspend: false,
            active: 0,
            lastSchedule: '—',
            age: '1h',
        };
        expect(resourceListOutputSchema.safeParse({ kind: 'CronJob', items: [cronRow] }).success).toBe(true);
        const hpaRow = {
            name: 'h',
            namespace: 'a',
            reference: 'Deployment/web',
            min: 1,
            max: 3,
            replicas: 1,
            targets: '—',
            targetCpuPercent: null,
            age: '1h',
        };
        expect(resourceListOutputSchema.safeParse({ kind: 'HorizontalPodAutoscaler', items: [hpaRow] }).success).toBe(
            true,
        );
        const cmRow = { name: 'app-config', namespace: 'a', keys: 2, size: '40 B', age: '1h' };
        expect(resourceListOutputSchema.safeParse({ kind: 'ConfigMap', items: [cmRow] }).success).toBe(true);
        const secretRow = { name: 's', namespace: 'a', type: 'Opaque', keys: 1, age: '1h' };
        expect(resourceListOutputSchema.safeParse({ kind: 'Secret', items: [secretRow] }).success).toBe(true);
        expect(
            resourceGetOutputSchema.safeParse({ kind: 'Secret', item: { ...secretRow, labels: [], annotations: [] } })
                .success,
        ).toBe(true);
        const deployment = {
            name: 'web',
            namespace: 'a',
            status: 'Healthy',
            ready: '1/1',
            replicas: 1,
            updated: 1,
            available: 1,
            strategy: 'RollingUpdate',
            image: 'x',
            paused: false,
            age: '1h',
        };
        expect(resourceListOutputSchema.safeParse({ kind: 'Deployment', items: [deployment] }).success).toBe(true);
        expect(
            resourceListOutputSchema.safeParse({ kind: 'Deployment', items: [{ ...deployment, status: 'Odd' }] })
                .success,
        ).toBe(false);
        expect(resourceGetOutputSchema.safeParse({ kind: 'Deployment', item: deployment }).success).toBe(false);
        expect(
            resourceGetOutputSchema.safeParse({
                kind: 'Deployment',
                item: { ...deployment, labels: [], annotations: [] },
            }).success,
        ).toBe(true);
        expect(
            resourceListOutputSchema.safeParse({
                kind: 'DaemonSet',
                items: [
                    {
                        name: 'a',
                        namespace: 'b',
                        desired: 1,
                        current: 1,
                        ready: 1,
                        upToDate: 1,
                        nodeSelector: '<none>',
                        age: '1h',
                    },
                ],
            }).success,
        ).toBe(true);
    });
});
