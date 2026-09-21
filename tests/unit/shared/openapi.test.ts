import { describe, expect, it } from 'vitest';
import {
    apiVersionSchema,
    kindNameSchema,
    kindSchemaInputSchema,
    kindSchemaSchema,
    refName,
    refTo,
    schemaNodeSchema,
} from '../../../src/shared/k8s/openapi';

describe('OpenAPI contract', () => {
    it('names the definition a reference points at, and refuses references it does not follow', () => {
        expect(refName('#/components/schemas/io.k8s.api.core.v1.Pod')).toBe('io.k8s.api.core.v1.Pod');
        expect(refName('#/definitions/io.k8s.api.core.v1.Pod')).toBeNull();
        expect(refName('https://example.com/schema.json')).toBeNull();
        expect(refTo('io.k8s.api.core.v1.Pod')).toBe('#/components/schemas/io.k8s.api.core.v1.Pod');
        expect(refName(refTo('x'))).toBe('x');
    });

    it('accepts a group-version as a manifest writes it and nothing that could leave the document path', () => {
        for (const value of ['v1', 'v1beta1', 'apps/v1', 'autoscaling/v2', 'rbac.authorization.k8s.io/v1']) {
            expect(apiVersionSchema.safeParse(value).success).toBe(true);
        }
        for (const value of ['', '/', 'apps/v1/extra', '../etc/passwd', 'apps/v1?hash=x', 'Apps/v1', 'apps /v1']) {
            expect(apiVersionSchema.safeParse(value).success).toBe(false);
        }
    });

    it('accepts a Kubernetes kind name and refuses anything else', () => {
        for (const value of ['Pod', 'CustomResourceDefinition', 'Widget42']) {
            expect(kindNameSchema.safeParse(value).success).toBe(true);
        }
        for (const value of ['', 'pod-1', '1Pod', 'Pod/List', 'Pod.v1']) {
            expect(kindNameSchema.safeParse(value).success).toBe(false);
        }
        expect(kindSchemaInputSchema.safeParse({ apiVersion: 'apps/v1', kind: 'Deployment' }).success).toBe(true);
        expect(kindSchemaInputSchema.safeParse({ apiVersion: 'apps/v1' }).success).toBe(false);
    });

    it('carries a schema node through every level of nesting and drops what it does not declare', () => {
        const parsed = schemaNodeSchema.parse({
            type: 'object',
            description: 'A spec.',
            required: ['template'],
            properties: {
                replicas: { type: 'integer', format: 'int32', default: 1, nullable: true },
                strategy: { $ref: '#/components/schemas/Strategy', example: 'dropped' },
                ports: { type: 'array', items: { type: 'integer' } },
                labels: { type: 'object', additionalProperties: { type: 'string' } },
                closed: { type: 'object', additionalProperties: false },
                either: { anyOf: [{ type: 'string' }, { type: 'integer' }], 'x-kubernetes-int-or-string': true },
            },
            'x-kubernetes-group-version-kind': [{ group: 'apps', version: 'v1', kind: 'Deployment' }],
            'x-kubernetes-patch-strategy': 'merge',
        });
        expect(parsed.properties?.replicas).toEqual({ type: 'integer', format: 'int32', default: 1, nullable: true });
        expect(parsed.properties?.strategy).toEqual({ $ref: '#/components/schemas/Strategy' });
        expect(parsed.properties?.ports?.items).toEqual({ type: 'integer' });
        expect(parsed.properties?.labels?.additionalProperties).toEqual({ type: 'string' });
        expect(parsed.properties?.closed?.additionalProperties).toBe(false);
        expect(parsed.properties?.either?.['x-kubernetes-int-or-string']).toBe(true);
        expect(parsed['x-kubernetes-group-version-kind']).toEqual([
            { group: 'apps', version: 'v1', kind: 'Deployment' },
        ]);
        expect(parsed).not.toHaveProperty('x-kubernetes-patch-strategy');
    });

    it('refuses a node whose declared fields are the wrong shape', () => {
        expect(schemaNodeSchema.safeParse({ required: 'template' }).success).toBe(false);
        expect(schemaNodeSchema.safeParse({ properties: { a: { type: 42 } } }).success).toBe(false);
        expect(schemaNodeSchema.safeParse({ 'x-kubernetes-group-version-kind': [{ kind: 'Pod' }] }).success).toBe(
            false,
        );
    });

    it('answers a kind with its own definition name and the definitions it reaches', () => {
        const answer = {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            document: 'apis/apps/v1',
            name: 'io.k8s.api.apps.v1.Deployment',
            definitions: { 'io.k8s.api.apps.v1.Deployment': { type: 'object' } },
        };
        expect(kindSchemaSchema.safeParse(answer).success).toBe(true);
        expect(kindSchemaSchema.safeParse({ ...answer, definitions: undefined }).success).toBe(false);
    });
});
