import { describe, expect, it } from 'vitest';
import {
    closure,
    documentPath,
    findKindName,
    hashOf,
    normalizeDefinitions,
    normalizeNode,
    normalizeSchemas,
    parseDiscovery,
    splitApiVersion,
} from '../../../src/main/k8s/openapi/document';

describe('documentPath', () => {
    it('sends the core group to /api and every other group to /apis', () => {
        expect(documentPath('v1')).toBe('api/v1');
        expect(documentPath('apps/v1')).toBe('apis/apps/v1');
        expect(documentPath('example.com/v1alpha1')).toBe('apis/example.com/v1alpha1');
    });
});

describe('splitApiVersion', () => {
    it('reads the core group as the empty group the API server reports it as', () => {
        expect(splitApiVersion('v1')).toEqual({ group: '', version: 'v1' });
        expect(splitApiVersion('apps/v1')).toEqual({ group: 'apps', version: 'v1' });
    });
});

describe('parseDiscovery', () => {
    it('maps every published document to the URL that serves it', () => {
        const paths = parseDiscovery({
            paths: {
                'api/v1': { serverRelativeURL: '/openapi/v3/api/v1?hash=AAA' },
                'apis/apps/v1': { serverRelativeURL: '/openapi/v3/apis/apps/v1?hash=BBB' },
            },
        });
        expect(paths?.get('apis/apps/v1')).toBe('/openapi/v3/apis/apps/v1?hash=BBB');
        expect(paths?.size).toBe(2);
    });

    it('drops an entry that names no URL, and refuses a URL that leaves the OpenAPI endpoint', () => {
        const paths = parseDiscovery({
            paths: {
                'api/v1': { serverRelativeURL: '/openapi/v3/api/v1?hash=AAA' },
                'apis/apps/v1': {},
                'apis/batch/v1': { serverRelativeURL: 'https://elsewhere.test/openapi/v3/apis/batch/v1' },
                'apis/rbac.authorization.k8s.io/v1': { serverRelativeURL: '/api/v1/namespaces/kube-system/secrets' },
            },
        });
        expect([...(paths?.keys() ?? [])]).toEqual(['api/v1']);
    });

    it('answers null for a body that is not a discovery listing', () => {
        expect(parseDiscovery(undefined)).toBeNull();
        expect(parseDiscovery({ paths: 'none' })).toBeNull();
        expect(parseDiscovery('<html>404</html>')).toBeNull();
    });
});

describe('hashOf', () => {
    it('reads the hash the API server keys a document by', () => {
        expect(hashOf('/openapi/v3/apis/apps/v1?hash=3FA9B2')).toBe('3FA9B2');
    });

    it('answers null when the URL carries no hash, so nothing is cached under a key that is not one', () => {
        expect(hashOf('/openapi/v3/apis/apps/v1')).toBeNull();
        expect(hashOf('not a url at all')).toBeNull();
    });
});

describe('normalizeNode', () => {
    it('keeps the fields validation and completion read and drops the rest', () => {
        expect(
            normalizeNode({
                type: 'object',
                description: 'A spec.',
                required: ['template'],
                properties: { replicas: { type: 'integer', default: 1, example: 3 } },
                'x-kubernetes-patch-merge-key': 'name',
            }),
        ).toEqual({
            type: 'object',
            description: 'A spec.',
            required: ['template'],
            properties: { replicas: { type: 'integer', default: 1 } },
        });
    });

    it('keeps a false additionalProperties apart from one that is a schema', () => {
        expect(normalizeNode({ additionalProperties: false }).additionalProperties).toBe(false);
        expect(normalizeNode({ additionalProperties: { type: 'string' } }).additionalProperties).toEqual({
            type: 'string',
        });
        expect(normalizeNode({ additionalProperties: 'yes' })).toEqual({});
    });

    it('normalises every branch of a composed node', () => {
        const node = normalizeNode({
            allOf: [{ $ref: '#/components/schemas/A', example: 1 }],
            anyOf: [{ type: 'string' }],
            oneOf: [{ type: 'integer' }],
            items: { type: 'string', title: 'dropped' },
            enum: ['Recreate', 'RollingUpdate'],
            'x-kubernetes-int-or-string': true,
            'x-kubernetes-preserve-unknown-fields': true,
        });
        expect(node.allOf).toEqual([{ $ref: '#/components/schemas/A' }]);
        expect(node.anyOf).toEqual([{ type: 'string' }]);
        expect(node.oneOf).toEqual([{ type: 'integer' }]);
        expect(node.items).toEqual({ type: 'string' });
        expect(node.enum).toEqual(['Recreate', 'RollingUpdate']);
        expect(node['x-kubernetes-int-or-string']).toBe(true);
        expect(node['x-kubernetes-preserve-unknown-fields']).toBe(true);
    });

    it('answers an empty node for anything that is not one, so one odd field cannot fail a document', () => {
        expect(normalizeNode(null)).toEqual({});
        expect(normalizeNode('object')).toEqual({});
        expect(normalizeNode({ type: 42, required: 'template', properties: [], enum: 'Recreate' })).toEqual({});
    });

    it('keeps a group-version-kind only when every part of it is there', () => {
        expect(
            normalizeNode({ 'x-kubernetes-group-version-kind': [{ group: '', version: 'v1', kind: 'Pod' }] }),
        ).toEqual({ 'x-kubernetes-group-version-kind': [{ group: '', version: 'v1', kind: 'Pod' }] });
        expect(normalizeNode({ 'x-kubernetes-group-version-kind': [{ kind: 'Pod' }] })).toEqual({});
        expect(normalizeNode({ 'x-kubernetes-group-version-kind': {} })).toEqual({});
    });
});

describe('normalizeSchemas', () => {
    it('reads the component schemas a document publishes', () => {
        const schemas = normalizeSchemas({
            openapi: '3.0.0',
            components: { schemas: { A: { type: 'object', example: {} }, B: { type: 'string' } } },
        });
        expect(schemas).toEqual({ A: { type: 'object' }, B: { type: 'string' } });
    });

    it('answers an empty map for a document that publishes none', () => {
        expect(normalizeSchemas({ openapi: '3.0.0' })).toEqual({});
        expect(normalizeSchemas(undefined)).toEqual({});
        expect(normalizeDefinitions('nothing')).toEqual({});
    });
});

const SCHEMAS = normalizeSchemas({
    components: {
        schemas: {
            'io.k8s.api.apps.v1.Deployment': {
                type: 'object',
                properties: { spec: { $ref: '#/components/schemas/io.k8s.api.apps.v1.DeploymentSpec' } },
                'x-kubernetes-group-version-kind': [{ group: 'apps', version: 'v1', kind: 'Deployment' }],
            },
            'io.k8s.api.apps.v1.DeploymentSpec': {
                type: 'object',
                properties: {
                    template: { $ref: '#/components/schemas/io.k8s.api.core.v1.PodTemplateSpec' },
                    history: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/io.k8s.api.apps.v1.DeploymentSpec' },
                    },
                },
            },
            'io.k8s.api.core.v1.PodTemplateSpec': { type: 'object' },
            'io.k8s.api.apps.v1.DeploymentList': {
                type: 'object',
                'x-kubernetes-group-version-kind': [{ group: 'apps', version: 'v1', kind: 'DeploymentList' }],
            },
            'io.k8s.api.core.v1.Unreachable': { type: 'object' },
        },
    },
});

describe('findKindName', () => {
    it('finds a kind by what the schema says it describes, not by what it is called', () => {
        expect(findKindName(SCHEMAS, { group: 'apps', version: 'v1', kind: 'Deployment' })).toBe(
            'io.k8s.api.apps.v1.Deployment',
        );
        expect(findKindName(SCHEMAS, { group: 'apps', version: 'v1', kind: 'DeploymentList' })).toBe(
            'io.k8s.api.apps.v1.DeploymentList',
        );
    });

    it('answers null when the document describes no such kind', () => {
        expect(findKindName(SCHEMAS, { group: 'apps', version: 'v1', kind: 'Widget' })).toBeNull();
        expect(findKindName(SCHEMAS, { group: '', version: 'v1', kind: 'Deployment' })).toBeNull();
        expect(findKindName({}, { group: 'apps', version: 'v1', kind: 'Deployment' })).toBeNull();
    });
});

describe('closure', () => {
    it('collects the kind and everything it reaches, and nothing it does not', () => {
        expect(Object.keys(closure(SCHEMAS, 'io.k8s.api.apps.v1.Deployment')).sort()).toEqual([
            'io.k8s.api.apps.v1.Deployment',
            'io.k8s.api.apps.v1.DeploymentSpec',
            'io.k8s.api.core.v1.PodTemplateSpec',
        ]);
    });

    it('terminates on a schema that refers to itself', () => {
        expect(Object.keys(closure(SCHEMAS, 'io.k8s.api.apps.v1.DeploymentSpec')).sort()).toEqual([
            'io.k8s.api.apps.v1.DeploymentSpec',
            'io.k8s.api.core.v1.PodTemplateSpec',
        ]);
    });

    it('follows a reference wherever it is hidden: a composed branch, a map value, a list item', () => {
        const schemas = normalizeSchemas({
            components: {
                schemas: {
                    Root: {
                        properties: {
                            described: { allOf: [{ $ref: '#/components/schemas/Described' }], description: 'One.' },
                            either: {
                                oneOf: [{ $ref: '#/components/schemas/First' }],
                                anyOf: [{ $ref: '#/components/schemas/Second' }],
                            },
                            map: { additionalProperties: { $ref: '#/components/schemas/Value' } },
                            list: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
                            closed: { additionalProperties: false },
                        },
                    },
                    Described: { type: 'object' },
                    First: { type: 'object' },
                    Second: { type: 'object' },
                    Value: { type: 'string' },
                    Item: { type: 'string' },
                },
            },
        });
        expect(Object.keys(closure(schemas, 'Root')).sort()).toEqual([
            'Described',
            'First',
            'Item',
            'Root',
            'Second',
            'Value',
        ]);
    });

    it('leaves out a reference the document does not define rather than inventing an empty schema', () => {
        const schemas = normalizeSchemas({
            components: { schemas: { A: { $ref: '#/components/schemas/Missing' }, B: { $ref: 'https://x.test/s' } } },
        });
        expect(Object.keys(closure(schemas, 'A'))).toEqual(['A']);
        expect(Object.keys(closure(schemas, 'B'))).toEqual(['B']);
        expect(closure(schemas, 'Missing')).toEqual({});
    });
});
