import { ApiException } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const objects = { patch: vi.fn() };
vi.mock('../../../src/main/k8s/client.js', () => ({
    apis: () => ({ objects }),
    activeContextName: () => 'alpha',
    getActiveNamespace: () => 'team-a',
    listItems: vi.fn(),
}));

const apply = await import('../../../src/main/k8s/resources/helm-apply.js');

const conflict = (causes: { reason?: string; message?: string; field?: string }[]) =>
    new ApiException(409, 'Conflict', { kind: 'Status', reason: 'Conflict', details: { causes } }, {});

beforeEach(() => {
    objects.patch.mockReset().mockResolvedValue({});
});

describe('applyForRelease', () => {
    it('applies server-side as helm, stamped with the release’s ownership, never forcing unless asked', async () => {
        const rendered = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: 'shop' } };
        await apply.applyForRelease(rendered, 'web', 'shop');
        expect(objects.patch).toHaveBeenCalledWith(
            {
                apiVersion: 'apps/v1',
                kind: 'Deployment',
                metadata: {
                    name: 'web',
                    namespace: 'shop',
                    labels: { 'app.kubernetes.io/managed-by': 'Helm' },
                    annotations: { 'meta.helm.sh/release-name': 'web', 'meta.helm.sh/release-namespace': 'shop' },
                },
            },
            undefined,
            undefined,
            'helm',
            false,
            'application/apply-patch+yaml',
        );
        // The rendered object is the release's stored render, which must not carry the stamp.
        expect(rendered.metadata).toEqual({ name: 'web', namespace: 'shop' });

        await apply.applyForRelease(rendered, 'web', 'shop', { dryRun: true, force: true });
        expect(objects.patch.mock.calls[1]!.slice(2)).toEqual(['All', 'helm', true, 'application/apply-patch+yaml']);
    });
});

describe('applyConflicts', () => {
    it('reads each field and manager a refused apply names', () => {
        expect(
            apply.applyConflicts(
                conflict([
                    {
                        reason: 'FieldManagerConflict',
                        message: 'conflict with "kubectl" using apps/v1',
                        field: '.spec.replicas',
                    },
                    {
                        reason: 'FieldManagerConflict',
                        message: 'conflict with "argocd"',
                        field: '.metadata.labels.tier',
                    },
                ]),
            ),
        ).toEqual([
            { field: '.spec.replicas', manager: 'kubectl' },
            { field: '.metadata.labels.tier', manager: 'argocd' },
        ]);
    });

    it('reads the Status an API server answers, as the text the client hands over', () => {
        // Verbatim from k3s: the body arrives unparsed, and Go's StatusCause.Type goes over the wire as `reason`.
        const body =
            '{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure","message":"Apply failed with 1 conflict: conflict with \\"helm\\" using v1: .data.colour","reason":"Conflict","details":{"causes":[{"reason":"FieldManagerConflict","message":"conflict with \\"helm\\" using v1","field":".data.colour"}]},"code":409}\n';
        expect(apply.applyConflicts(new ApiException(409, 'Conflict', body, {}))).toEqual([
            { field: '.data.colour', manager: 'helm' },
        ]);
        expect(apply.applyConflicts(new ApiException(409, 'Conflict', '<html>proxy error</html>', {}))).toBeNull();
    });

    it('is null for anything that is not an apply conflict', () => {
        expect(apply.applyConflicts(new ApiException(409, 'AlreadyExists', { kind: 'Status' }, {}))).toBeNull();
        expect(apply.applyConflicts(conflict([{ reason: 'FieldValueInvalid', field: '.spec' }]))).toBeNull();
        expect(apply.applyConflicts(new ApiException(422, 'Invalid', { kind: 'Status' }, {}))).toBeNull();
        expect(apply.applyConflicts(new Error('fetch failed'))).toBeNull();
    });

    it('says the whole conflict in a sentence rather than the server’s status', () => {
        const error = apply.conflictError('releases.upgrade', 'Deployment "web" in shop', [
            { field: '.spec.replicas', manager: 'kubectl' },
        ]);
        expect(error).toMatchObject({ kind: 'conflict', op: 'releases.upgrade' });
        expect(error.detail).toMatch(/^Deployment "web" in shop: \.spec\.replicas is managed by "kubectl"\. /);
    });
});

describe('clientSideOwnership', () => {
    const entry = (manager: string, operation: string, fieldsV1: object, extra: object = {}) => ({
        manager,
        operation,
        apiVersion: 'v1',
        fieldsType: 'FieldsV1',
        fieldsV1,
        ...extra,
    });

    it('folds Helm’s update entries into its apply entry and leaves every other manager alone', () => {
        const managed = apply.clientSideOwnership({
            metadata: {
                managedFields: [
                    entry('helm', 'Update', { 'f:data': { 'f:a': {} } }, { time: '2026-01-01T00:00:00Z' }),
                    entry('kubectl', 'Update', { 'f:data': { 'f:b': {} } }),
                    entry('helm', 'Apply', { 'f:data': { 'f:c': {} }, 'f:metadata': {} }),
                    entry('helm', 'Update', { 'f:data': { 'f:d': {} } }, { subresource: 'status' }),
                ],
            },
        });
        expect(managed).toEqual([
            entry('kubectl', 'Update', { 'f:data': { 'f:b': {} } }),
            entry('helm', 'Update', { 'f:data': { 'f:d': {} } }, { subresource: 'status' }),
            entry(
                'helm',
                'Apply',
                { 'f:data': { 'f:c': {}, 'f:a': {} }, 'f:metadata': {} },
                { time: '2026-01-01T00:00:00Z' },
            ),
        ]);
    });

    it('makes an apply entry when Helm never applied, and is null when Helm holds nothing client-side', () => {
        expect(
            apply.clientSideOwnership({ metadata: { managedFields: [entry('helm', 'Update', { 'f:data': {} })] } }),
        ).toEqual([entry('helm', 'Apply', { 'f:data': {} }, { time: undefined })]);
        expect(
            apply.clientSideOwnership({ metadata: { managedFields: [entry('helm', 'Apply', { 'f:data': {} })] } }),
        ).toBeNull();
        expect(apply.clientSideOwnership({ metadata: {} })).toBeNull();
    });

    it('moves the ownership with a merge patch conditional on the version read, and only when there is some', async () => {
        const live = {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: {
                name: 'web',
                namespace: 'shop',
                resourceVersion: '42',
                managedFields: [entry('helm', 'Update', { 'f:data': {} })],
            },
        };
        await expect(apply.moveClientSideOwnership(live)).resolves.toBe(true);
        expect(objects.patch).toHaveBeenCalledWith(
            {
                apiVersion: 'v1',
                kind: 'ConfigMap',
                metadata: {
                    name: 'web',
                    namespace: 'shop',
                    resourceVersion: '42',
                    managedFields: [entry('helm', 'Apply', { 'f:data': {} }, { time: undefined })],
                },
            },
            undefined,
            undefined,
            'helm',
            undefined,
            'application/merge-patch+json',
        );
        objects.patch.mockClear();
        await expect(apply.moveClientSideOwnership({ ...live, metadata: { name: 'web' } })).resolves.toBe(false);
        expect(objects.patch).not.toHaveBeenCalled();
    });
});
