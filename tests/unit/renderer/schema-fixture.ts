import type { KindSchema, SchemaNode } from '../../../src/shared/k8s/openapi';

/**
 * A Deployment's schema shaped the way the API server publishes one, for the editor's checks and
 * completion: refs wrapped in `allOf`, never inlined, with the int-or-string and quantity shapes
 * older servers use.
 */

const ref = (name: string): SchemaNode => ({ allOf: [{ $ref: `#/components/schemas/${name}` }] });
const string: SchemaNode = { type: 'string' };
const stringMap: SchemaNode = { type: 'object', additionalProperties: { type: 'string', default: '' } };

/** Shaped as the API server publishes it: refs wrapped in `allOf`, never inlined. */
export const deployment: KindSchema = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    document: 'apis/apps/v1',
    name: 'io.k8s.api.apps.v1.Deployment',
    definitions: {
        'io.k8s.api.apps.v1.Deployment': {
            type: 'object',
            properties: {
                apiVersion: string,
                kind: string,
                metadata: ref('io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta'),
                spec: ref('io.k8s.api.apps.v1.DeploymentSpec'),
            },
        },
        'io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta': {
            type: 'object',
            properties: { name: string, generateName: string, namespace: string, labels: stringMap },
        },
        'io.k8s.api.apps.v1.DeploymentSpec': {
            type: 'object',
            required: ['selector', 'template'],
            properties: {
                replicas: { type: 'integer', format: 'int32', description: 'Number of desired pods.' },
                selector: { type: 'object', properties: { matchLabels: stringMap } },
                template: ref('io.k8s.api.core.v1.PodTemplateSpec'),
                strategy: {
                    type: 'object',
                    properties: { type: { type: 'string', enum: ['Recreate', 'RollingUpdate'] } },
                },
                extra: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
            },
        },
        'io.k8s.api.core.v1.PodTemplateSpec': {
            type: 'object',
            properties: {
                metadata: ref('io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta'),
                spec: ref('io.k8s.api.core.v1.PodSpec'),
            },
        },
        'io.k8s.api.core.v1.PodSpec': {
            type: 'object',
            required: ['containers'],
            properties: { containers: { type: 'array', items: ref('io.k8s.api.core.v1.Container') } },
        },
        'io.k8s.api.core.v1.Container': {
            type: 'object',
            required: ['name'],
            properties: {
                name: { type: 'string', description: 'Name of the container.' },
                image: string,
                imagePullPolicy: { type: 'string', enum: ['Always', 'IfNotPresent', 'Never'] },
                stdin: { type: 'boolean' },
                env: {
                    type: 'array',
                    items: { type: 'object', required: ['name'], properties: { name: string, value: string } },
                },
                ports: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['containerPort'],
                        properties: { containerPort: { type: 'integer' }, name: string },
                    },
                },
                resources: {
                    type: 'object',
                    properties: {
                        limits: {
                            type: 'object',
                            additionalProperties: ref('io.k8s.apimachinery.pkg.api.resource.Quantity'),
                        },
                    },
                },
                readinessProbe: {
                    type: 'object',
                    properties: {
                        port: { $ref: '#/components/schemas/io.k8s.apimachinery.pkg.util.intstr.IntOrString' },
                        grace: { 'x-kubernetes-int-or-string': true },
                        mode: { oneOf: [{ type: 'string' }, { type: 'boolean' }] },
                    },
                },
            },
        },
        // Published as a plain string by older servers, though a number is what everyone writes.
        'io.k8s.apimachinery.pkg.api.resource.Quantity': { type: 'string' },
        'io.k8s.apimachinery.pkg.util.intstr.IntOrString': { type: 'string', format: 'int-or-string' },
    },
};
