import { ApiException } from '@kubernetes/client-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const objects = { create: vi.fn(), replace: vi.fn(), delete: vi.fn(), patch: vi.fn(), resource: vi.fn() };
const apps = {
    readNamespacedDeploymentScale: vi.fn(),
    replaceNamespacedDeploymentScale: vi.fn(),
    readNamespacedStatefulSetScale: vi.fn(),
    replaceNamespacedStatefulSetScale: vi.fn(),
};
const client = {
    apis: () => ({ objects, apps }),
    getActiveNamespace: vi.fn<() => string | null>(),
    activeContextName: vi.fn<() => string>(),
};
vi.mock('../../../src/main/k8s/client.js', () => client);

const write = await import('../../../src/main/k8s/resources/write.js');

const CONFIG_MAP = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: app-config', 'data:', '  a: b'].join(
    '\n',
);
const ON_ALPHA = { context: 'alpha' };

beforeEach(() => {
    vi.clearAllMocks();
    client.getActiveNamespace.mockReturnValue('team-a');
    client.activeContextName.mockReturnValue('alpha');
    objects.create.mockImplementation(async (spec: Record<string, unknown>) => spec);
    objects.replace.mockImplementation(async (spec: Record<string, unknown>) => spec);
    // Discovery is only asked about kinds the registry does not know.
    objects.resource.mockResolvedValue(undefined);
});

describe('parseManifest', () => {
    it('rejects text that is not YAML', () => {
        expect(() => write.parseManifest('a:\n b: [', 'op')).toThrowError(/not valid YAML/);
    });

    it('rejects a list, a scalar and an empty document', () => {
        for (const text of ['- a\n- b', 'just a string', '']) {
            expect(() => write.parseManifest(text, 'op')).toThrowError(/single YAML object/);
        }
    });

    it('rejects an object without a type or a name', () => {
        expect(() => write.parseManifest('metadata:\n  name: x', 'op')).toThrowError(/apiVersion and kind/);
        expect(() => write.parseManifest('apiVersion: v1\nkind: Pod', 'op')).toThrowError(/metadata.name/);
    });

    it('accepts a generated name, which only a create can use', () => {
        const spec = write.parseManifest('apiVersion: v1\nkind: Pod\nmetadata:\n  generateName: web-', 'op');
        expect(spec.metadata?.generateName).toBe('web-');
    });
});

describe('context stamp', () => {
    it('refuses every write whose stamp names a context other than the one main is on', async () => {
        client.activeContextName.mockReturnValue('beta');
        const stale = { context: 'alpha' };
        const expected = { kind: 'conflict', detail: expect.stringContaining('meant for context "alpha"') };
        await expect(write.createResource({ ...stale, manifest: CONFIG_MAP })).rejects.toMatchObject(expected);
        await expect(write.replaceResource({ ...stale, manifest: CONFIG_MAP })).rejects.toMatchObject(expected);
        await expect(
            write.deleteResource({ ...stale, kind: 'ConfigMap', name: 'app-config', namespace: 'team-a' }),
        ).rejects.toMatchObject(expected);
        await expect(
            write.scaleResource({ ...stale, kind: 'Deployment', name: 'web', namespace: 'team-a', replicas: 1 }),
        ).rejects.toMatchObject(expected);
        await expect(
            write.restartResource({ ...stale, kind: 'Deployment', name: 'web', namespace: 'team-a' }),
        ).rejects.toMatchObject(expected);
        expect(objects.create).not.toHaveBeenCalled();
        expect(objects.replace).not.toHaveBeenCalled();
        expect(objects.delete).not.toHaveBeenCalled();
        expect(objects.patch).not.toHaveBeenCalled();
        expect(apps.readNamespacedDeploymentScale).not.toHaveBeenCalled();
    });
});

describe('createResource', () => {
    it('applies the active namespace to a namespaced kind that omits one', async () => {
        expect(await write.createResource({ ...ON_ALPHA, manifest: CONFIG_MAP })).toEqual({
            kind: 'ConfigMap',
            name: 'app-config',
            namespace: 'team-a',
        });
        expect(objects.create).toHaveBeenCalledWith(
            expect.objectContaining({ metadata: { name: 'app-config', namespace: 'team-a' } }),
            undefined,
            undefined,
        );
        expect(objects.resource).not.toHaveBeenCalled();
    });

    it('keeps a namespace the manifest states', async () => {
        const manifest = CONFIG_MAP.replace('  name: app-config', '  name: app-config\n  namespace: other');
        expect(await write.createResource({ ...ON_ALPHA, manifest })).toMatchObject({ namespace: 'other' });
    });

    it('never gives a namespace to a cluster-scoped kind, registered or not', async () => {
        client.getActiveNamespace.mockReturnValue('team-a');
        const kinds = [
            ['rbac.authorization.k8s.io/v1', 'ClusterRole'],
            ['v1', 'Namespace'],
            ['scheduling.k8s.io/v1', 'PriorityClass'],
            ['storage.k8s.io/v1', 'VolumeAttachment'],
        ];
        for (const [apiVersion, kind] of kinds) {
            const manifest = `apiVersion: ${apiVersion}\nkind: ${kind}\nmetadata:\n  name: thing\n  namespace: team-a`;
            expect(await write.createResource({ ...ON_ALPHA, manifest })).toMatchObject({ namespace: undefined });
        }
        expect(objects.resource).not.toHaveBeenCalled();
    });

    it('asks discovery about a custom resource named like a built-in kind rather than borrowing its scope', async () => {
        // Longhorn's Node is namespaced, unlike the core one: its namespace must survive.
        const longhornNode =
            'apiVersion: longhorn.io/v1beta2\nkind: Node\nmetadata:\n  name: worker-1\n  namespace: longhorn-system';
        objects.resource.mockResolvedValue({ name: 'nodes', namespaced: true });
        expect(await write.createResource({ ...ON_ALPHA, manifest: longhornNode })).toMatchObject({
            namespace: 'longhorn-system',
        });
        expect(objects.resource).toHaveBeenCalledWith('longhorn.io/v1beta2', 'Node');
        expect(objects.create).toHaveBeenLastCalledWith(
            expect.objectContaining({ metadata: { name: 'worker-1', namespace: 'longhorn-system' } }),
            undefined,
            undefined,
        );

        // OpenShift's Ingress is cluster-scoped, unlike the networking one: it needs no namespace.
        client.getActiveNamespace.mockReturnValue(null);
        objects.resource.mockResolvedValue({ name: 'ingresses', namespaced: false });
        const openshiftIngress = 'apiVersion: config.openshift.io/v1\nkind: Ingress\nmetadata:\n  name: cluster';
        expect(await write.createResource({ ...ON_ALPHA, manifest: openshiftIngress })).toMatchObject({
            namespace: undefined,
        });
        expect(objects.resource).toHaveBeenCalledWith('config.openshift.io/v1', 'Ingress');
    });

    it('refuses a namespaced kind with no namespace anywhere instead of letting the client pick one', async () => {
        client.getActiveNamespace.mockReturnValue(null);
        await expect(write.createResource({ ...ON_ALPHA, manifest: CONFIG_MAP })).rejects.toMatchObject({
            kind: 'invalid',
            op: 'resources.create',
            detail: 'ConfigMap "app-config" needs a namespace: select one or add metadata.namespace.',
        });
        expect(objects.create).not.toHaveBeenCalled();
    });

    it('asks discovery about an unknown kind and scopes it accordingly', async () => {
        const manifest = 'apiVersion: example.io/v1\nkind: Widget\nmetadata:\n  name: w';
        objects.resource.mockResolvedValue({ name: 'widgets', namespaced: true });
        expect(await write.createResource({ ...ON_ALPHA, manifest })).toMatchObject({ namespace: 'team-a' });
        expect(objects.resource).toHaveBeenCalledWith('example.io/v1', 'Widget');

        objects.resource.mockResolvedValue({ name: 'widgets', namespaced: false });
        const scoped = `${manifest}\n  namespace: team-a`;
        expect(await write.createResource({ ...ON_ALPHA, manifest: scoped })).toMatchObject({ namespace: undefined });

        client.getActiveNamespace.mockReturnValue(null);
        objects.resource.mockResolvedValue({ name: 'widgets', namespaced: true });
        await expect(write.createResource({ ...ON_ALPHA, manifest })).rejects.toMatchObject({ kind: 'invalid' });

        objects.resource.mockResolvedValue(undefined);
        await expect(write.createResource({ ...ON_ALPHA, manifest })).rejects.toMatchObject({
            kind: 'invalid',
            detail: 'The API server does not know example.io/v1 Widget.',
        });
    });

    it('asks the server to run admission without persisting on a dry run', async () => {
        await write.createResource({ ...ON_ALPHA, manifest: CONFIG_MAP, dryRun: true });
        expect(objects.create).toHaveBeenCalledWith(expect.anything(), undefined, 'All');
    });

    it('reports what the server named the object when the manifest only generated one', async () => {
        objects.create.mockResolvedValue({ kind: 'Pod', metadata: { name: 'web-x7k2q', namespace: 'team-a' } });
        const manifest = 'apiVersion: v1\nkind: Pod\nmetadata:\n  generateName: web-';
        expect(await write.createResource({ ...ON_ALPHA, manifest })).toEqual({
            kind: 'Pod',
            name: 'web-x7k2q',
            namespace: 'team-a',
        });
    });

    it('classifies a rejected write, including a name that is already taken', async () => {
        objects.create.mockRejectedValue(new ApiException(409, 'exists', { message: 'already exists' }, {}));
        await expect(write.createResource({ ...ON_ALPHA, manifest: CONFIG_MAP })).rejects.toMatchObject({
            kind: 'conflict',
            op: 'resources.create',
        });
    });
});

describe('replaceResource', () => {
    const VERSIONED = CONFIG_MAP.replace('  name: app-config', '  name: app-config\n  resourceVersion: "42"');
    const IN_TEAM_A = VERSIONED.replace('  name: app-config', '  name: app-config\n  namespace: team-a');

    it('replaces an object that carries the version it was read with', async () => {
        expect(await write.replaceResource({ ...ON_ALPHA, manifest: VERSIONED })).toMatchObject({ name: 'app-config' });
        expect(objects.replace).toHaveBeenCalledWith(
            expect.objectContaining({ metadata: expect.objectContaining({ resourceVersion: '42' }) }),
            undefined,
            undefined,
        );
    });

    it('refuses a manifest without a resource version, which would overwrite blindly', async () => {
        await expect(write.replaceResource({ ...ON_ALPHA, manifest: CONFIG_MAP })).rejects.toMatchObject({
            kind: 'invalid',
            detail: expect.stringContaining('resourceVersion'),
        });
        expect(objects.replace).not.toHaveBeenCalled();
    });

    it('refuses a generated name, which no existing object has', async () => {
        const manifest = 'apiVersion: v1\nkind: Pod\nmetadata:\n  generateName: web-\n  resourceVersion: "1"';
        await expect(write.replaceResource({ ...ON_ALPHA, manifest })).rejects.toMatchObject({ kind: 'invalid' });
    });

    it('reports a concurrent change as a conflict rather than overwriting it', async () => {
        objects.replace.mockRejectedValue(new ApiException(409, 'conflict', { message: 'modified' }, {}));
        await expect(write.replaceResource({ ...ON_ALPHA, manifest: VERSIONED })).rejects.toMatchObject({
            kind: 'conflict',
        });
    });

    it('runs admission without persisting on a dry run', async () => {
        await write.replaceResource({ ...ON_ALPHA, manifest: VERSIONED, dryRun: true });
        expect(objects.replace).toHaveBeenCalledWith(expect.anything(), undefined, 'All');
    });

    it('saves a manifest that still describes the object the editor was opened on', async () => {
        const expect_ = { kind: 'ConfigMap' as const, name: 'app-config', namespace: 'team-a' };
        expect(await write.replaceResource({ ...ON_ALPHA, manifest: IN_TEAM_A, expect: expect_ })).toMatchObject({
            namespace: 'team-a',
        });
    });

    it('refuses a manifest that was re-aimed at another object, even on a dry run', async () => {
        const editing = { kind: 'ConfigMap' as const, name: 'app-config', namespace: 'team-a' };
        const cases: Array<[string, string]> = [
            ['name', IN_TEAM_A.replace('name: app-config', 'name: other-config')],
            ['namespace', IN_TEAM_A.replace('namespace: team-a', 'namespace: billing')],
            ['kind', IN_TEAM_A.replace('kind: ConfigMap', 'kind: Secret')],
            // Dropping the namespace line would otherwise let the active namespace stand in.
            ['missing namespace', VERSIONED],
        ];
        for (const [, manifest] of cases) {
            await expect(
                write.replaceResource({ ...ON_ALPHA, manifest, expect: editing, dryRun: true }),
            ).rejects.toMatchObject({
                kind: 'invalid',
                op: 'resources.replace',
                detail: expect.stringContaining('this editor is for ConfigMap "team-a/app-config"'),
            });
        }
        expect(objects.replace).not.toHaveBeenCalled();
    });

    it('pins a cluster-scoped object to no namespace at all', async () => {
        const role =
            'apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: reader\n  resourceVersion: "3"';
        const editing = { kind: 'ClusterRole' as const, name: 'reader' };
        expect(await write.replaceResource({ ...ON_ALPHA, manifest: role, expect: editing })).toMatchObject({
            kind: 'ClusterRole',
            namespace: undefined,
        });
        await expect(
            write.replaceResource({
                ...ON_ALPHA,
                manifest: role.replace('name: reader', 'name: writer'),
                expect: editing,
            }),
        ).rejects.toMatchObject({ detail: expect.stringContaining('ClusterRole "reader"') });
    });
    it('saves a custom resource named like a cluster-scoped built-in kind into its namespace', async () => {
        const manifest = [
            'apiVersion: longhorn.io/v1beta2',
            'kind: Node',
            'metadata:',
            '  name: worker-1',
            '  namespace: longhorn-system',
            '  resourceVersion: "7"',
        ].join('\n');
        objects.resource.mockResolvedValue({ name: 'nodes', namespaced: true });
        const editing = {
            apiVersion: 'longhorn.io/v1beta2',
            kind: 'Node',
            name: 'worker-1',
            namespace: 'longhorn-system',
        };
        expect(await write.replaceResource({ ...ON_ALPHA, manifest, expect: editing })).toMatchObject({
            kind: 'Node',
            namespace: 'longhorn-system',
        });
    });

    it("refuses a manifest re-aimed at another group's kind of the same name", async () => {
        const manifest = 'apiVersion: v1\nkind: Node\nmetadata:\n  name: worker-1\n  resourceVersion: "7"';
        const editing = {
            apiVersion: 'longhorn.io/v1beta2',
            kind: 'Node',
            name: 'worker-1',
            namespace: 'longhorn-system',
        };
        await expect(write.replaceResource({ ...ON_ALPHA, manifest, expect: editing })).rejects.toMatchObject({
            kind: 'invalid',
            detail: expect.stringContaining(
                'describes v1 Node "worker-1", but this editor is for longhorn.io/v1beta2 Node "longhorn-system/worker-1"',
            ),
        });
        expect(objects.replace).not.toHaveBeenCalled();
    });
});

describe('deleteResource', () => {
    it('deletes a namespaced object in exactly the namespace named', async () => {
        client.getActiveNamespace.mockReturnValue('other');
        expect(
            await write.deleteResource({ ...ON_ALPHA, kind: 'ConfigMap', name: 'app-config', namespace: 'team-a' }),
        ).toEqual({ kind: 'ConfigMap', name: 'app-config', namespace: 'team-a' });
        // A delete with no stated grace period leaves the object's own to apply.
        expect(objects.delete).toHaveBeenCalledWith(
            {
                apiVersion: 'v1',
                kind: 'ConfigMap',
                metadata: { name: 'app-config', namespace: 'team-a' },
            },
            undefined,
            undefined,
            undefined,
        );
    });

    it('passes a grace period through, which is how a pod is deleted without waiting', async () => {
        await write.deleteResource({
            ...ON_ALPHA,
            kind: 'Pod',
            name: 'web-1',
            namespace: 'team-a',
            gracePeriodSeconds: 0,
        });
        expect(objects.delete).toHaveBeenCalledWith(expect.anything(), undefined, undefined, 0);
    });

    it('refuses a namespaced delete without a namespace, never falling back to the active one', async () => {
        client.getActiveNamespace.mockReturnValue('team-a');
        await expect(
            write.deleteResource({ ...ON_ALPHA, kind: 'ConfigMap', name: 'app-config' }),
        ).rejects.toMatchObject({
            kind: 'invalid',
            op: 'resources.delete',
            detail: 'A namespace is required to address ConfigMap "app-config".',
        });
        expect(objects.delete).not.toHaveBeenCalled();
    });

    it('deletes a cluster-scoped object with no namespace at all', async () => {
        expect(await write.deleteResource({ ...ON_ALPHA, kind: 'ClusterRole', name: 'reader' })).toMatchObject({
            namespace: undefined,
        });
        expect(objects.delete).toHaveBeenCalledWith(
            {
                apiVersion: 'rbac.authorization.k8s.io/v1',
                kind: 'ClusterRole',
                metadata: { name: 'reader', namespace: undefined },
            },
            undefined,
            undefined,
            undefined,
        );
    });

    it('deletes a node, which is not a registered kind', async () => {
        expect(await write.deleteResource({ ...ON_ALPHA, kind: 'Node', name: 'node-1' })).toMatchObject({
            kind: 'Node',
        });
    });

    it('reports an object that is already gone as not found', async () => {
        objects.delete.mockRejectedValue(new ApiException(404, 'gone', {}, {}));
        await expect(
            write.deleteResource({ ...ON_ALPHA, kind: 'ConfigMap', name: 'ghost', namespace: 'team-a' }),
        ).rejects.toMatchObject({ kind: 'notFound' });
    });
});

describe('restartResource', () => {
    const web = { ...ON_ALPHA, kind: 'Deployment' as const, name: 'web', namespace: 'team-a' };

    beforeEach(() => {
        objects.patch.mockResolvedValue({});
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('stamps the pod template with the moment of the restart and touches nothing else', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-16T10:00:00.000Z'));
        expect(await write.restartResource(web)).toEqual({ kind: 'Deployment', name: 'web', namespace: 'team-a' });
        expect(objects.patch).toHaveBeenCalledWith({
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'web', namespace: 'team-a' },
            spec: {
                template: {
                    metadata: { annotations: { [write.RESTART_ANNOTATION]: '2026-09-16T10:00:00.000Z' } },
                },
            },
        });
    });

    it('addresses a stateful set and a daemon set through their own api version and kind', async () => {
        await write.restartResource({ ...web, kind: 'StatefulSet', name: 'db' });
        await write.restartResource({ ...web, kind: 'DaemonSet', name: 'agent' });
        expect(objects.patch).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ kind: 'StatefulSet', metadata: { name: 'db', namespace: 'team-a' } }),
        );
        expect(objects.patch).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ kind: 'DaemonSet', metadata: { name: 'agent', namespace: 'team-a' } }),
        );
    });

    it('refuses to restart without a namespace, never falling back to the active one', async () => {
        await expect(write.restartResource({ ...web, namespace: '' })).rejects.toMatchObject({
            kind: 'invalid',
            op: 'resources.restart',
        });
        expect(objects.patch).not.toHaveBeenCalled();
    });

    it('reports a workload that is already gone as not found', async () => {
        objects.patch.mockRejectedValue(new ApiException(404, 'gone', {}, {}));
        await expect(write.restartResource(web)).rejects.toMatchObject({ kind: 'notFound' });
    });
});

describe('scaleResource', () => {
    const web = { ...ON_ALPHA, kind: 'Deployment' as const, name: 'web', namespace: 'team-a' };

    it('reads the current scale and writes back the requested count', async () => {
        apps.readNamespacedDeploymentScale.mockResolvedValue({
            metadata: { resourceVersion: '7' },
            spec: { replicas: 2 },
        });
        apps.replaceNamespacedDeploymentScale.mockResolvedValue({});
        expect(await write.scaleResource({ ...web, replicas: 5 })).toEqual({
            kind: 'Deployment',
            name: 'web',
            namespace: 'team-a',
        });
        expect(apps.replaceNamespacedDeploymentScale).toHaveBeenCalledWith({
            name: 'web',
            namespace: 'team-a',
            body: { metadata: { resourceVersion: '7' }, spec: { replicas: 5 } },
        });
    });

    it('scales a stateful set through its own subresource', async () => {
        apps.readNamespacedStatefulSetScale.mockResolvedValue({ spec: { replicas: 1 } });
        apps.replaceNamespacedStatefulSetScale.mockResolvedValue({});
        await write.scaleResource({ ...web, kind: 'StatefulSet', name: 'db', replicas: 3 });
        expect(apps.replaceNamespacedStatefulSetScale).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'db', body: { spec: { replicas: 3 } } }),
        );
    });

    it('refuses a kind that has no scale subresource', async () => {
        await expect(write.scaleResource({ ...web, kind: 'ConfigMap', replicas: 1 })).rejects.toMatchObject({
            kind: 'invalid',
            detail: 'ConfigMap cannot be scaled.',
        });
    });

    it('refuses to scale without a namespace, never falling back to the active one', async () => {
        await expect(
            write.scaleResource({ ...ON_ALPHA, kind: 'Deployment', name: 'web', replicas: 1 }),
        ).rejects.toMatchObject({ kind: 'invalid', op: 'resources.scale' });
        expect(apps.readNamespacedDeploymentScale).not.toHaveBeenCalled();
    });

    it('reports a scale that raced another writer as a conflict', async () => {
        apps.readNamespacedDeploymentScale.mockResolvedValue({ spec: { replicas: 2 } });
        apps.replaceNamespacedDeploymentScale.mockRejectedValue(new ApiException(409, 'conflict', {}, {}));
        await expect(write.scaleResource({ ...web, replicas: 1 })).rejects.toMatchObject({ kind: 'conflict' });
    });
});
