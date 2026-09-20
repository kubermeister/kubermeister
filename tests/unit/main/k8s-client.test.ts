import { ApiException } from '@kubernetes/client-node';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/settings';

const FIXTURE = resolve('tests/unit/fixtures/kubeconfig.yaml');
const INVALID_ENTRIES = resolve('tests/unit/fixtures/kubeconfig-invalid-entries.yaml');

let settings: Settings;
vi.mock('../../../src/main/settings/store.js', () => ({
    getSettings: () => settings,
    updateSettings: vi.fn(),
}));

async function loadClient() {
    vi.resetModules();
    return import('../../../src/main/k8s/client.js');
}

function withSettings(patch: Partial<Settings['session']>, kubeconfigPath: string | null = FIXTURE): void {
    settings = {
        version: 1,
        session: { ...DEFAULT_SETTINGS.session, ...patch },
        connection: { kubeconfigPath },
    };
}

describe('kubeConfig', () => {
    beforeEach(() => withSettings({}));

    it('loads the configured file and seeds the namespace from its current context', async () => {
        const { kubeConfig, getActiveNamespace } = await loadClient();
        expect(kubeConfig().getCurrentContext()).toBe('alpha');
        expect(getActiveNamespace()).toBe('team-a');
    });

    it('restores the remembered context and namespace without writing the file', async () => {
        withSettings({ lastContext: 'beta', lastNamespace: 'remembered' });
        const { kubeConfig, getActiveNamespace } = await loadClient();
        expect(kubeConfig().getCurrentContext()).toBe('beta');
        expect(getActiveNamespace()).toBe('remembered');
        const fresh = await import('@kubernetes/client-node');
        const onDisk = new fresh.KubeConfig();
        onDisk.loadFromFile(FIXTURE);
        expect(onDisk.getCurrentContext()).toBe('alpha');
    });

    it('falls back to the remembered context default namespace, then to none', async () => {
        withSettings({ lastContext: 'beta', lastNamespace: null });
        const { getActiveNamespace } = await loadClient();
        expect(getActiveNamespace()).toBeNull();
    });

    it('ignores a remembered context that no longer exists or when restore is off', async () => {
        withSettings({ lastContext: 'gone' });
        expect((await loadClient()).kubeConfig().getCurrentContext()).toBe('alpha');
        withSettings({ lastContext: 'beta', restoreOnLaunch: false });
        expect((await loadClient()).kubeConfig().getCurrentContext()).toBe('alpha');
    });

    it('drops entries kubectl tolerates (empty cluster, no name, no server) and keeps the rest', async () => {
        withSettings({}, INVALID_ENTRIES);
        const { kubeConfig, getActiveNamespace } = await loadClient();
        const kc = kubeConfig();
        expect(kc.getContexts().map((c) => c.name)).toEqual(['alpha']);
        expect(kc.getClusters().map((c) => c.name)).toEqual(['alpha-cluster']);
        expect(kc.getUsers().map((u) => u.name)).toEqual(['alpha-user']);
        expect(kc.getCurrentContext()).toBe('alpha');
        expect(getActiveNamespace()).toBe('team-a');
    });

    it('memoises the config and API clients until invalidated or reloaded', async () => {
        const { kubeConfig, apis, invalidateApis, reloadKubeConfig, setActiveNamespace, getActiveNamespace } =
            await loadClient();
        const first = kubeConfig();
        const bundle = apis();
        expect(kubeConfig()).toBe(first);
        expect(apis()).toBe(bundle);
        expect(Object.keys(bundle).sort()).toEqual(
            [
                'admission',
                'apiextensions',
                'apiregistration',
                'apps',
                'batch',
                'coordination',
                'core',
                'customObjects',
                'flowcontrol',
                'hpa',
                'net',
                'objects',
                'policy',
                'rbac',
                'runtime',
                'scheduling',
                'storage',
                'version',
            ].sort(),
        );
        invalidateApis();
        expect(apis()).not.toBe(bundle);
        expect(kubeConfig()).toBe(first);
        setActiveNamespace('manual');
        reloadKubeConfig();
        expect(kubeConfig()).not.toBe(first);
        expect(getActiveNamespace()).toBe('team-a');
    });
});

describe('kubeconfigError', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'km-kc-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('accepts a valid configured file', async () => {
        withSettings({});
        expect((await loadClient()).kubeconfigError()).toBeNull();
    });

    it('accepts a file with invalid entries, as kubectl does', async () => {
        withSettings({}, INVALID_ENTRIES);
        expect((await loadClient()).kubeconfigError()).toBeNull();
    });

    it('reports a missing configured file by path', async () => {
        withSettings({}, join(dir, 'missing'));
        expect((await loadClient()).kubeconfigError()).toBe(`No file exists at ${join(dir, 'missing')}.`);
    });

    it('reports an unparseable configured file without leaking its contents', async () => {
        const bad = join(dir, 'bad.yaml');
        writeFileSync(bad, 'secret-token: [unterminated');
        withSettings({}, bad);
        const message = (await loadClient()).kubeconfigError();
        expect(message).toBe(`${bad} could not be parsed as a kubeconfig file.`);
        expect(message).not.toContain('secret-token');
    });

    it('reports an unusable default kubeconfig in general terms', async () => {
        // tests/setup.ts points $KUBECONFIG at a file that does not exist.
        withSettings({}, null);
        expect((await loadClient()).kubeconfigError()).toBe(
            'The default kubeconfig ($KUBECONFIG or ~/.kube/config) could not be parsed.',
        );
    });
});

describe('namespace helpers', () => {
    beforeEach(() => withSettings({}));

    it('resolves explicit, active, then all', async () => {
        const { resolveNamespace, resolveObjectNamespace, setActiveNamespace } = await loadClient();
        expect(resolveNamespace('explicit')).toBe('explicit');
        expect(resolveNamespace()).toBe('team-a');
        setActiveNamespace(null);
        expect(resolveNamespace()).toBeUndefined();
        expect(resolveObjectNamespace()).toBeNull();
        expect(resolveObjectNamespace('x')).toBe('x');
    });

    it('listItems dispatches to the namespaced or the cluster-wide reader', async () => {
        const { listItems, setActiveNamespace } = await loadClient();
        const namespaced = vi.fn(async (ns: string) => ({ items: [`ns:${ns}`] }));
        const all = vi.fn(async () => ({ items: ['all'] }));
        expect(await listItems(undefined, namespaced, all)).toEqual({ items: ['ns:team-a'] });
        expect(await listItems('other', namespaced, all)).toEqual({ items: ['ns:other'] });
        expect(await listItems('other', namespaced, all, true)).toEqual({ items: ['all'] });
        setActiveNamespace(null);
        expect(await listItems(undefined, namespaced, all)).toEqual({ items: ['all'] });
    });

    it('isSafeSelectorValue accepts DNS-1123 names and rejects selector syntax', async () => {
        const { isSafeSelectorValue } = await loadClient();
        expect(isSafeSelectorValue('web-7d9f.v2')).toBe(true);
        for (const bad of ['a,b', 'a=b', 'a b', '', 'ns/name', '$(id)']) expect(isSafeSelectorValue(bad)).toBe(false);
    });

    it('readOrNull maps a 404 to undefined and rethrows anything else', async () => {
        const { readOrNull } = await loadClient();
        await expect(readOrNull(() => Promise.reject(new ApiException(404, 'x', null, {})))).resolves.toBeUndefined();
        await expect(readOrNull(() => Promise.reject(new ApiException(403, 'x', null, {})))).rejects.toBeInstanceOf(
            ApiException,
        );
        await expect(readOrNull(() => Promise.resolve('found'))).resolves.toBe('found');
    });

    it('getNamespaced reads directly in the explicit or active namespace and fails closed without one', async () => {
        const { getNamespaced, setActiveNamespace } = await loadClient();
        const readOne = vi.fn(async (name: string, ns: string) => `${ns}/${name}`);
        expect(await getNamespaced('web', 'explicit', readOne)).toBe('explicit/web');
        expect(await getNamespaced('web', undefined, readOne)).toBe('team-a/web');
        setActiveNamespace(null);
        // No namespace means not found: the cluster is never searched for a same-named object.
        expect(await getNamespaced('web', undefined, readOne)).toBeUndefined();
        expect(readOne).toHaveBeenCalledTimes(2);
    });

    it('isSafeLabelKey and isSafeLabelValue accept real labels and reject selector syntax', async () => {
        const { isSafeLabelKey, isSafeLabelValue } = await loadClient();
        expect(isSafeLabelKey('app.kubernetes.io/name')).toBe(true);
        expect(isSafeLabelValue('')).toBe(true);
        expect(isSafeLabelValue('web_1.2-3')).toBe(true);
        for (const bad of ['a,b', 'a=b', 'a!b', 'a b']) {
            expect(isSafeLabelKey(bad)).toBe(false);
            expect(isSafeLabelValue(bad)).toBe(false);
        }
    });

    it('only accepts a well-formed namespace name as the active selection', async () => {
        const { setActiveNamespace, getActiveNamespace } = await loadClient();
        for (const bad of ['', 'Team-A', 'a b', 'ns/other', 'a,b']) {
            setActiveNamespace(bad);
            expect(getActiveNamespace()).toBeNull();
        }
        setActiveNamespace('kube-system');
        expect(getActiveNamespace()).toBe('kube-system');
    });

    it('drops a malformed remembered namespace at startup instead of activating it', async () => {
        withSettings({ lastContext: 'beta', lastNamespace: '' });
        expect((await loadClient()).getActiveNamespace()).toBeNull();
        withSettings({ lastContext: 'alpha', lastNamespace: 'Not A Namespace' });
        expect((await loadClient()).getActiveNamespace()).toBeNull();
    });

    it('names the context every call currently goes to', async () => {
        const { activeContextName, kubeConfig } = await loadClient();
        expect(activeContextName()).toBe('alpha');
        kubeConfig().setCurrentContext('beta');
        expect(activeContextName()).toBe('beta');
    });
});

describe('a kubeconfig that will not load', () => {
    const savedKubeconfigEnv = process.env.KUBECONFIG;
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'km-client-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        if (savedKubeconfigEnv === undefined) delete process.env.KUBECONFIG;
        else process.env.KUBECONFIG = savedKubeconfigEnv;
    });

    it('fails every access as a classified kubeconfig error that names the path, never the contents', async () => {
        const broken = join(dir, 'broken.yaml');
        writeFileSync(broken, 'apiVersion: v1\nclusters: [ this is not yaml\nsecret-token-in-file: hunter2\n');
        withSettings({}, broken);
        const { kubeConfig, getActiveNamespace, activeContextName } = await loadClient();
        for (const access of [kubeConfig, getActiveNamespace, activeContextName]) {
            let caught: unknown;
            try {
                access();
            } catch (error) {
                caught = error;
            }
            expect(caught).toMatchObject({
                name: 'K8sError',
                kind: 'kubeconfig',
                op: 'kubeconfig',
                detail: `${broken} could not be parsed as a kubeconfig file.`,
            });
            expect(String((caught as Error).message)).not.toContain('hunter2');
        }
    });

    it('names a configured path that does not exist', async () => {
        const missing = join(dir, 'missing.yaml');
        withSettings({}, missing);
        const { kubeConfig } = await loadClient();
        expect(() => kubeConfig()).toThrow(
            expect.objectContaining({ kind: 'kubeconfig', detail: `No file exists at ${missing}.` }),
        );
    });

    it('speaks of the default kubeconfig when no path is configured', async () => {
        const broken = join(dir, 'default.yaml');
        writeFileSync(broken, '{{ not a kubeconfig');
        process.env.KUBECONFIG = broken;
        withSettings({}, null);
        const { kubeConfig } = await loadClient();
        expect(() => kubeConfig()).toThrow(
            expect.objectContaining({
                kind: 'kubeconfig',
                detail: 'The default kubeconfig ($KUBECONFIG or ~/.kube/config) could not be parsed.',
            }),
        );
    });
});

describe('a context the kubeconfig cannot back', () => {
    const BROKEN = resolve('tests/unit/fixtures/kubeconfig-broken-context.yaml');

    beforeEach(() => withSettings({}, BROKEN));

    it('names the missing cluster or user, and nothing for a whole context or an unknown name', async () => {
        const { kubeConfig, contextProblem } = await loadClient();
        const kc = kubeConfig();
        expect(contextProblem(kc, 'alpha')).toBe(
            'Context "alpha" names cluster "nowhere", which the kubeconfig does not define or which has no server.',
        );
        expect(contextProblem(kc, 'ghost-user')).toBe(
            'Context "ghost-user" names user "nobody", which the kubeconfig does not define.',
        );
        expect(contextProblem(kc, 'beta')).toBeNull();
        expect(contextProblem(kc, 'gone')).toBe('Context "gone" is not in the kubeconfig.');
    });

    it('reports the current context problem and none once a whole context is current', async () => {
        const { kubeConfig, currentContextProblem, invalidateApis, apis } = await loadClient();
        expect(currentContextProblem()).toContain('names cluster "nowhere"');
        // Building clients fails closed with the same sentence rather than the library's own.
        expect(() => apis()).toThrow(
            expect.objectContaining({
                name: 'K8sError',
                kind: 'kubeconfig',
                detail: expect.stringContaining('nowhere'),
            }),
        );
        kubeConfig().setCurrentContext('beta');
        invalidateApis();
        expect(currentContextProblem()).toBeNull();
        expect(apis().core).toBeDefined();
    });

    it('has no current context problem when no context is current', async () => {
        const { kubeConfig, currentContextProblem } = await loadClient();
        kubeConfig().setCurrentContext('');
        expect(currentContextProblem()).toBeNull();
    });
});
