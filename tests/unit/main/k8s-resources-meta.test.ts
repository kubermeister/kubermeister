import { ApiException } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findRawObject = vi.fn();
vi.mock('../../../src/main/k8s/resources/manifest.js', () => ({ findRawObject }));
vi.mock('../../../src/main/k8s/client.js', () => ({}));

const { getObjectMeta } = await import('../../../src/main/k8s/resources/meta.js');

const CREATED = '2026-09-14T10:00:00.000Z';

describe('getObjectMeta', () => {
    beforeEach(() => {
        // A block body: an arrow returning the mock makes Vitest treat it as a teardown and call it.
        findRawObject.mockReset();
    });

    it('names the controller above the object, linked when the app can show that kind', async () => {
        findRawObject.mockResolvedValue({
            metadata: {
                name: 'web-1',
                namespace: 'team-a',
                uid: 'u1',
                creationTimestamp: new Date(CREATED),
                ownerReferences: [
                    { apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-7d9', uid: 'r1', controller: true },
                ],
            },
        });
        await expect(getObjectMeta('Pod', 'web-1', 'team-a')).resolves.toEqual({
            owner: {
                apiVersion: 'apps/v1',
                kind: 'ReplicaSet',
                name: 'web-7d9',
                namespace: 'team-a',
                path: '/workloads/replicasets/team-a/web-7d9',
            },
            finalizers: [],
            deleting: false,
            created: CREATED,
            uid: 'u1',
        });
    });

    it('reports what is holding a deletion open, which is why an object sits in Terminating', async () => {
        findRawObject.mockResolvedValue({
            metadata: {
                name: 'team-a',
                deletionTimestamp: new Date(CREATED),
                finalizers: ['kubernetes'],
            },
        });
        await expect(getObjectMeta('Namespace', 'team-a')).resolves.toMatchObject({
            deleting: true,
            finalizers: ['kubernetes'],
            owner: null,
            created: '',
        });
    });

    it('leaves an owner unlinked when the app has no screen for that kind', async () => {
        findRawObject.mockResolvedValue({
            metadata: {
                name: 'x',
                namespace: 'team-a',
                ownerReferences: [{ apiVersion: 'example.com/v1', kind: 'Widget', name: 'left', uid: 'w1' }],
            },
        });
        const meta = await getObjectMeta('ConfigMap', 'x', 'team-a');
        expect(meta.owner).toMatchObject({ kind: 'Widget', name: 'left', path: null });
    });

    it('leaves unlinked an owner whose kind is named like a built-in one in another API group', async () => {
        findRawObject.mockResolvedValue({
            metadata: {
                name: 'train-0',
                namespace: 'team-a',
                ownerReferences: [
                    {
                        apiVersion: 'batch.volcano.sh/v1alpha1',
                        kind: 'Job',
                        name: 'train',
                        uid: 'v1',
                        controller: true,
                    },
                ],
            },
        });
        const meta = await getObjectMeta('Pod', 'train-0', 'team-a');
        expect(meta.owner).toMatchObject({ apiVersion: 'batch.volcano.sh/v1alpha1', kind: 'Job', path: null });
    });

    it('reports a missing object rather than empty metadata', async () => {
        findRawObject.mockResolvedValue(undefined);
        await expect(getObjectMeta('Pod', 'gone', 'team-a')).rejects.toMatchObject({
            kind: 'notFound',
            op: 'resources.meta',
        });
    });

    it('classifies a refusal from the read under its own channel', async () => {
        findRawObject.mockImplementation(() => Promise.reject(new ApiException(403, 'x', { message: 'denied' }, {})));
        const failure = await getObjectMeta('Pod', 'web-1', 'team-a').catch((error: unknown) => error);
        expect(failure).toMatchObject({ kind: 'forbidden', op: 'resources.meta' });
    });
});
