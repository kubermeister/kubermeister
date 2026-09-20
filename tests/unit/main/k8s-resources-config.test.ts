import { ApiException, type V1ConfigMap, type V1Secret } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = {
    listNamespacedConfigMap: vi.fn(),
    listConfigMapForAllNamespaces: vi.fn(),
    readNamespacedConfigMap: vi.fn(),
    listNamespacedSecret: vi.fn(),
    listSecretForAllNamespaces: vi.fn(),
    readNamespacedSecret: vi.fn(),
};
const client = {
    apis: () => ({ core }),
    getActiveNamespace: vi.fn<() => string | null>(),
    resolveObjectNamespace: (explicit?: string) => explicit ?? client.getActiveNamespace(),
    isSafeSelectorValue: () => true,
    listItems: async <T>(
        ns: string | undefined,
        namespaced: (ns: string) => Promise<{ items: T[] }>,
        all: () => Promise<{ items: T[] }>,
    ) => {
        const resolved = ns ?? client.getActiveNamespace() ?? undefined;
        return resolved ? namespaced(resolved) : all();
    },
    readOrNull: async <T>(read: () => Promise<T>) => {
        try {
            return await read();
        } catch (error) {
            if (error instanceof ApiException && error.code === 404) return undefined;
            throw error;
        }
    },
    getNamespaced: async <T>(
        name: string,
        namespace: string | undefined,
        readOne: (name: string, ns: string) => Promise<T>,
    ) => {
        const ns = client.resolveObjectNamespace(namespace);
        if (!ns) return undefined;
        return client.readOrNull(() => readOne(name, ns));
    },
};
vi.mock('../../../src/main/k8s/client.js', () => client);

const config = await import('../../../src/main/k8s/resources/config.js');

const NOW = Date.parse('2026-09-15T12:00:00Z');
const HOUR = 3600 * 1000;

const configMap = (overrides: Partial<V1ConfigMap> = {}): V1ConfigMap =>
    ({
        metadata: {
            name: 'app-config',
            namespace: 'team-a',
            creationTimestamp: new Date(NOW - HOUR),
            labels: { app: 'x' },
        },
        data: { greeting: 'hello', 'nginx.conf': 'server {\n  listen 80;\n}' },
        binaryData: { 'logo.png': Buffer.from('binary-bytes').toString('base64') },
        ...overrides,
    }) as V1ConfigMap;

const secret = (overrides: Partial<V1Secret> = {}): V1Secret =>
    ({
        metadata: { name: 'app-secret', namespace: 'team-a', creationTimestamp: new Date(NOW - HOUR) },
        type: 'Opaque',
        data: { password: Buffer.from('super-secret-value').toString('base64'), token: 'dG9rZW4=' },
        ...overrides,
    }) as V1Secret;

describe('config map transforms', () => {
    it('counts text and binary keys and sums their stored bytes', () => {
        expect(config.configMapByteSize(configMap())).toBe(5 + 23 + 12);
        expect(config.toConfigMap(configMap(), NOW)).toEqual({
            name: 'app-config',
            namespace: 'team-a',
            keys: 3,
            size: '40 B',
            age: '1h',
        });
        expect(config.toConfigMap({ metadata: { name: 'empty' } }, NOW)).toMatchObject({ keys: 0, size: '0 B' });
    });

    it('guesses the content type from the value shape', () => {
        expect(config.contentType('{"a":1}')).toBe('application/json');
        expect(config.contentType('  [1,2]')).toBe('application/json');
        expect(config.contentType('apiVersion: v1')).toBe('text/yaml');
        expect(config.contentType('line one\nline two')).toBe('text/yaml');
        expect(config.contentType('hello')).toBe('text/plain');
    });

    it('returns text entries with their size, leaving binary data out', () => {
        expect(config.toConfigMapEntries(configMap())).toEqual([
            { key: 'greeting', contentType: 'text/plain', size: '5 B', value: 'hello' },
            { key: 'nginx.conf', contentType: 'text/yaml', size: '23 B', value: 'server {\n  listen 80;\n}' },
        ]);
        expect(config.toConfigMapEntries({ metadata: {} })).toEqual([]);
    });

    it('carries label pairs on the detail', () => {
        expect(config.toConfigMapDetail(configMap(), NOW)).toMatchObject({ labels: [['app', 'x']], annotations: [] });
    });
});

describe('secret transforms', () => {
    it('reports the type and key count without any value', () => {
        expect(config.toSecret(secret(), NOW)).toEqual({
            name: 'app-secret',
            namespace: 'team-a',
            type: 'Opaque',
            keys: 2,
            age: '1h',
        });
        expect(config.toSecret({ metadata: { name: 'x' }, stringData: { a: 'b' } }, NOW)).toMatchObject({
            type: 'Opaque',
            keys: 1,
        });
    });

    it('masks every value and never returns the plaintext', () => {
        const entries = config.toSecretEntries(secret());
        expect(entries).toEqual([
            { key: 'password', masked: config.SECRET_MASK },
            { key: 'token', masked: config.SECRET_MASK },
        ]);
        expect(JSON.stringify(entries)).not.toContain('super-secret-value');
        expect(JSON.stringify(entries)).not.toContain(Buffer.from('super-secret-value').toString('base64'));
        expect(config.toSecretEntries({ metadata: {} })).toEqual([]);
    });
});

describe('config readers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        client.getActiveNamespace.mockReturnValue('team-a');
        core.listNamespacedConfigMap.mockResolvedValue({ items: [configMap()] });
        core.listConfigMapForAllNamespaces.mockResolvedValue({
            items: [configMap(), configMap({ metadata: { name: 'b', namespace: 'other' } })],
        });
        core.readNamespacedConfigMap.mockResolvedValue(configMap());
        core.listNamespacedSecret.mockResolvedValue({ items: [secret()] });
        core.listSecretForAllNamespaces.mockResolvedValue({ items: [] });
        core.readNamespacedSecret.mockResolvedValue(secret());
    });

    it('lists and gets config maps with their entries', async () => {
        expect((await config.listConfigMaps('explicit')).map((c) => c.name)).toEqual(['app-config']);
        expect(core.listNamespacedConfigMap).toHaveBeenCalledWith({ namespace: 'explicit' });
        await expect(config.getConfigMap('app-config', 'team-a')).resolves.toMatchObject({ keys: 3 });
        await expect(config.getConfigMapEntries('app-config', 'team-a')).resolves.toHaveLength(2);
        client.getActiveNamespace.mockReturnValue(null);
        expect((await config.listConfigMaps()).map((c) => c.namespace)).toEqual(['team-a', 'other']);
    });

    it('lists and gets secrets, returning masked entries only', async () => {
        expect((await config.listSecrets()).map((s) => s.type)).toEqual(['Opaque']);
        await expect(config.getSecret('app-secret', 'team-a')).resolves.toMatchObject({ keys: 2 });
        const entries = await config.getSecretEntries('app-secret', 'team-a');
        expect(entries.every((e) => e.masked === config.SECRET_MASK)).toBe(true);
    });

    it('reveals one key at a time, decoded, and keeps unreadable bytes base64', async () => {
        core.readNamespacedSecret.mockResolvedValue(
            secret({
                data: {
                    password: Buffer.from('super-secret-value').toString('base64'),
                    'keystore.p12': Buffer.from([0x30, 0x82, 0xff, 0xfe]).toString('base64'),
                },
            }),
        );
        await expect(config.revealSecretValue('app-secret', 'team-a', 'password')).resolves.toEqual({
            key: 'password',
            value: 'super-secret-value',
            binary: false,
        });
        await expect(config.revealSecretValue('app-secret', 'team-a', 'keystore.p12')).resolves.toEqual({
            key: 'keystore.p12',
            value: Buffer.from([0x30, 0x82, 0xff, 0xfe]).toString('base64'),
            binary: true,
        });
    });

    it('answers nothing for a key the secret does not carry', async () => {
        await expect(config.revealSecretValue('app-secret', 'team-a', 'absent')).resolves.toBeNull();
    });

    it('returns null and empty entries for objects that do not exist', async () => {
        core.readNamespacedConfigMap.mockRejectedValue(new ApiException(404, 'x', null, {}));
        core.readNamespacedSecret.mockRejectedValue(new ApiException(404, 'x', null, {}));
        await expect(config.getConfigMap('gone', 'team-a')).resolves.toBeNull();
        await expect(config.getConfigMapEntries('gone', 'team-a')).resolves.toEqual([]);
        await expect(config.getSecret('gone', 'team-a')).resolves.toBeNull();
        await expect(config.getSecretEntries('gone', 'team-a')).resolves.toEqual([]);
        await expect(config.revealSecretValue('gone', 'team-a', 'password')).resolves.toBeNull();
    });

    it('classifies failures under their channel ops', async () => {
        core.listNamespacedSecret.mockRejectedValue(new ApiException(403, 'x', { message: 'denied' }, {}));
        await expect(config.listSecrets()).rejects.toMatchObject({ kind: 'forbidden', op: 'resources.list' });
        core.readNamespacedSecret.mockRejectedValue(new ApiException(403, 'x', { message: 'denied' }, {}));
        await expect(config.getSecretEntries('app-secret', 'team-a')).rejects.toMatchObject({ op: 'secrets.entries' });
        await expect(config.revealSecretValue('app-secret', 'team-a', 'password')).rejects.toMatchObject({
            op: 'secrets.reveal',
        });
        core.readNamespacedConfigMap.mockRejectedValue(new ApiException(403, 'x', { message: 'denied' }, {}));
        await expect(config.getConfigMapEntries('app-config', 'team-a')).rejects.toMatchObject({
            op: 'configMaps.entries',
        });
    });
});
