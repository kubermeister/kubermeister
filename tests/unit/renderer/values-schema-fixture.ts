import type { JsonSchema } from '../../../src/shared/chart-values';

/**
 * A chart's `values.schema.json` written the ways real charts write one: draft-07 `definitions`
 * and 2019+ `$defs` reached by `$ref`, a type given as a list, `allOf` composing two halves of one
 * object, `oneOf` for a value that may be written two ways, a closed object, a tuple and a
 * `const`. Descriptions and titles are both used, since charts use either.
 */
export const webChart: JsonSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['image'],
    properties: {
        replicaCount: { type: 'integer', description: 'How many pods to run.' },
        image: { $ref: '#/definitions/image' },
        service: {
            type: 'object',
            additionalProperties: false,
            properties: {
                type: { enum: ['ClusterIP', 'NodePort', 'LoadBalancer'], title: 'Service type' },
                port: { type: ['integer', 'string'] },
            },
        },
        ingress: {
            allOf: [
                { type: 'object', properties: { enabled: { type: 'boolean' } } },
                { required: ['hosts'], properties: { hosts: { type: 'array', items: { $ref: '#/$defs/host' } } } },
            ],
        },
        resources: {
            oneOf: [
                { type: 'string', enum: ['small', 'large'] },
                { type: 'object', properties: { cpu: { type: 'string' }, memory: { type: 'string' } } },
            ],
        },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        labels: { type: 'object', patternProperties: { '^app\\.': { type: 'string' } } },
        pair: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] },
        mode: { const: 'standard' },
        extra: true,
        forbidden: false,
        remote: { $ref: 'https://example.com/schema.json#/definitions/x' },
    },
    definitions: {
        image: {
            type: 'object',
            required: ['repository'],
            properties: {
                repository: { type: 'string', description: 'Where the image is pulled from.' },
                tag: { type: 'string' },
                pullPolicy: { enum: ['Always', 'IfNotPresent', 'Never'] },
            },
        },
    },
    $defs: {
        host: {
            type: 'object',
            required: ['host'],
            properties: { host: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } },
        },
    },
};

/** The chart's own values.yaml for that schema, which supplies whatever the edited text leaves out. */
export const WEB_DEFAULTS = 'replicaCount: 1\nimage:\n  repository: nginx\n  tag: ""\nservice:\n  type: ClusterIP\n';
