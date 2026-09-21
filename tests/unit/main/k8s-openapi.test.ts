import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { K8sError } from '../../../src/main/k8s/errors';

let userData = '';
vi.mock('electron', () => ({ app: { getPath: () => userData } }));

const applySecurityAuthentication = vi.fn((context: { setHeaderParam(key: string, value: string): void }) => {
    context.setHeaderParam('Authorization', 'Bearer secret');
    return Promise.resolve();
});
let cluster: { server: string } | null = { server: 'https://cluster.test' };
const client = {
    kubeConfig: vi.fn(() => ({ getCurrentCluster: () => cluster, applySecurityAuthentication })),
    activeContextName: vi.fn(() => 'alpha'),
};
vi.mock('../../../src/main/k8s/client.js', () => client);

const { getKindSchema, resetSchemaCache } = await import('../../../src/main/k8s/openapi/index.js');

const discovery = (appsHash = 'APPS1') => ({
    paths: {
        'api/v1': { serverRelativeURL: '/openapi/v3/api/v1?hash=CORE1' },
        'apis/apps/v1': { serverRelativeURL: `/openapi/v3/apis/apps/v1?hash=${appsHash}` },
        'apis/example.com/v1': { serverRelativeURL: '/openapi/v3/apis/example.com/v1?hash=CRD1' },
    },
});

const APPS = {
    components: {
        schemas: {
            'io.k8s.api.apps.v1.Deployment': {
                type: 'object',
                description: 'Deployment enables declarative updates.',
                properties: { spec: { $ref: '#/components/schemas/io.k8s.api.apps.v1.DeploymentSpec' } },
                'x-kubernetes-group-version-kind': [{ group: 'apps', version: 'v1', kind: 'Deployment' }],
            },
            'io.k8s.api.apps.v1.DeploymentSpec': {
                type: 'object',
                required: ['selector'],
                properties: { replicas: { type: 'integer', format: 'int32', example: 3 } },
            },
            'io.k8s.api.apps.v1.StatefulSet': {
                type: 'object',
                'x-kubernetes-group-version-kind': [{ group: 'apps', version: 'v1', kind: 'StatefulSet' }],
            },
            'io.k8s.api.core.v1.Unreachable': { type: 'object' },
        },
    },
};

const WIDGETS = {
    components: {
        schemas: {
            'com.example.v1.Widget': {
                type: 'object',
                properties: { spec: { type: 'object', properties: { size: { type: 'string', enum: ['S', 'L'] } } } },
                'x-kubernetes-group-version-kind': [{ group: 'example.com', version: 'v1', kind: 'Widget' }],
            },
        },
    },
};

type Answer = { status: number; body: unknown };
let answers: Map<string, Answer>;
let fetched: string[];

function respond(url: string): Answer {
    const answer = answers.get(url);
    if (!answer) throw new Error(`unexpected request to ${url}`);
    return answer;
}

const fetchMock = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
    fetched.push(url);
    const { status, body } = respond(url);
    expect(init.headers.Authorization).toBe('Bearer secret');
    return { status, ok: status >= 200 && status < 300, json: async () => body };
});

const DEPLOYMENT = { apiVersion: 'apps/v1', kind: 'Deployment' } as const;

describe('getKindSchema', () => {
    beforeEach(() => {
        userData = mkdtempSync(join(tmpdir(), 'km-schemas-'));
        vi.stubGlobal('fetch', fetchMock);
        vi.clearAllMocks();
        resetSchemaCache();
        fetched = [];
        answers = new Map([
            ['https://cluster.test/openapi/v3', { status: 200, body: discovery() }],
            ['https://cluster.test/openapi/v3/apis/apps/v1?hash=APPS1', { status: 200, body: APPS }],
            ['https://cluster.test/openapi/v3/apis/example.com/v1?hash=CRD1', { status: 200, body: WIDGETS }],
        ]);
    });

    afterEach(() => {
        rmSync(userData, { recursive: true, force: true });
        vi.unstubAllGlobals();
    });

    it('answers a kind with its own definition and everything it reaches, and nothing it does not', async () => {
        await expect(getKindSchema(DEPLOYMENT)).resolves.toEqual({
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            document: 'apis/apps/v1',
            name: 'io.k8s.api.apps.v1.Deployment',
            definitions: {
                'io.k8s.api.apps.v1.Deployment': {
                    type: 'object',
                    description: 'Deployment enables declarative updates.',
                    properties: { spec: { $ref: '#/components/schemas/io.k8s.api.apps.v1.DeploymentSpec' } },
                    'x-kubernetes-group-version-kind': [{ group: 'apps', version: 'v1', kind: 'Deployment' }],
                },
                'io.k8s.api.apps.v1.DeploymentSpec': {
                    type: 'object',
                    required: ['selector'],
                    properties: { replicas: { type: 'integer', format: 'int32' } },
                },
            },
        });
    });

    it('reads the documents from the API server with the credentials the kubeconfig applies', async () => {
        await getKindSchema(DEPLOYMENT);
        expect(fetched).toEqual([
            'https://cluster.test/openapi/v3',
            'https://cluster.test/openapi/v3/apis/apps/v1?hash=APPS1',
        ]);
        expect(applySecurityAuthentication).toHaveBeenCalledTimes(2);
    });

    it('answers a custom resource from its own definition, like any other kind', async () => {
        const answer = await getKindSchema({ apiVersion: 'example.com/v1', kind: 'Widget' });
        expect(answer?.name).toBe('com.example.v1.Widget');
        expect(answer?.document).toBe('apis/example.com/v1');
        expect(answer?.definitions['com.example.v1.Widget']?.properties?.spec?.properties?.size?.enum).toEqual([
            'S',
            'L',
        ]);
    });

    it('reads one document once for every kind it describes', async () => {
        await getKindSchema(DEPLOYMENT);
        await getKindSchema({ apiVersion: 'apps/v1', kind: 'StatefulSet' });
        expect(fetched.filter((url) => url.includes('apis/apps/v1'))).toHaveLength(1);
    });

    it('reads a cached document back from disk after the cluster is left, without asking for it again', async () => {
        await getKindSchema(DEPLOYMENT);
        resetSchemaCache();
        fetched = [];
        await expect(getKindSchema(DEPLOYMENT)).resolves.toMatchObject({ name: 'io.k8s.api.apps.v1.Deployment' });
        expect(fetched).toEqual(['https://cluster.test/openapi/v3']);
    });

    it('reads the document again once the cluster reports a different hash for it', async () => {
        await getKindSchema(DEPLOYMENT);
        resetSchemaCache();
        answers.set('https://cluster.test/openapi/v3', { status: 200, body: discovery('APPS2') });
        answers.set('https://cluster.test/openapi/v3/apis/apps/v1?hash=APPS2', { status: 200, body: WIDGETS });
        await expect(getKindSchema(DEPLOYMENT)).resolves.toBeNull();
        expect(fetched).toContain('https://cluster.test/openapi/v3/apis/apps/v1?hash=APPS2');
    });

    it('keeps one context’s documents out of another’s', async () => {
        await getKindSchema(DEPLOYMENT);
        resetSchemaCache();
        client.activeContextName.mockReturnValue('beta');
        fetched = [];
        await getKindSchema(DEPLOYMENT);
        expect(fetched).toContain('https://cluster.test/openapi/v3/apis/apps/v1?hash=APPS1');
        client.activeContextName.mockReturnValue('alpha');
    });

    it('asks the cluster again for a document it may not cache, since nothing keys the copy', async () => {
        answers.set('https://cluster.test/openapi/v3', {
            status: 200,
            body: { paths: { 'apis/apps/v1': { serverRelativeURL: '/openapi/v3/apis/apps/v1' } } },
        });
        answers.set('https://cluster.test/openapi/v3/apis/apps/v1', { status: 200, body: APPS });
        await getKindSchema(DEPLOYMENT);
        resetSchemaCache();
        await expect(getKindSchema(DEPLOYMENT)).resolves.toMatchObject({ name: 'io.k8s.api.apps.v1.Deployment' });
        expect(fetched.filter((url) => url.endsWith('/apis/apps/v1'))).toHaveLength(2);
    });

    it('answers nothing for a kind the cluster serves no schema for', async () => {
        await expect(getKindSchema({ apiVersion: 'apps/v1', kind: 'Widget' })).resolves.toBeNull();
        await expect(getKindSchema({ apiVersion: 'batch/v1', kind: 'Job' })).resolves.toBeNull();
    });

    it('answers nothing for a cluster that publishes no OpenAPI at all', async () => {
        answers.set('https://cluster.test/openapi/v3', { status: 404, body: { message: 'not found' } });
        await expect(getKindSchema(DEPLOYMENT)).resolves.toBeNull();

        resetSchemaCache();
        answers.set('https://cluster.test/openapi/v3', { status: 200, body: '<html>hi</html>' });
        await expect(getKindSchema(DEPLOYMENT)).resolves.toBeNull();
    });

    it('answers nothing when the document turns out to describe nothing', async () => {
        answers.set('https://cluster.test/openapi/v3/apis/apps/v1?hash=APPS1', { status: 200, body: { openapi: '3' } });
        await expect(getKindSchema(DEPLOYMENT)).resolves.toBeNull();
    });

    it('reports a refused read as the classified failure it is', async () => {
        answers.set('https://cluster.test/openapi/v3', { status: 403, body: { message: 'no' } });
        await expect(getKindSchema(DEPLOYMENT)).rejects.toMatchObject({ kind: 'forbidden', op: 'schemas.forKind' });

        resetSchemaCache();
        answers.set('https://cluster.test/openapi/v3', { status: 200, body: discovery() });
        answers.set('https://cluster.test/openapi/v3/apis/apps/v1?hash=APPS1', { status: 500, body: {} });
        await expect(getKindSchema(DEPLOYMENT)).rejects.toBeInstanceOf(K8sError);
    });

    it('fails with the kubeconfig rather than the network when the context names no cluster', async () => {
        cluster = null;
        try {
            await expect(getKindSchema(DEPLOYMENT)).rejects.toMatchObject({ kind: 'kubeconfig' });
            expect(fetched).toEqual([]);
        } finally {
            cluster = { server: 'https://cluster.test' };
        }
    });

    it('reports an unreachable cluster rather than answering that the kind has no schema', async () => {
        fetchMock.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }));
        await expect(getKindSchema(DEPLOYMENT)).rejects.toMatchObject({ kind: 'unreachable' });
    });

    it('asks the listing again once it is old enough to have missed a definition being installed', async () => {
        vi.useFakeTimers();
        try {
            await getKindSchema(DEPLOYMENT);
            await getKindSchema({ apiVersion: 'apps/v1', kind: 'StatefulSet' });
            expect(fetched.filter((url) => url.endsWith('/openapi/v3'))).toHaveLength(1);
            vi.advanceTimersByTime(120_000);
            await getKindSchema(DEPLOYMENT);
            expect(fetched.filter((url) => url.endsWith('/openapi/v3'))).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });
});
