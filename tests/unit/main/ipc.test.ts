import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '../../../src/shared/settings';
import { K8sError, readTimeoutMs, setReadTimeoutSec } from '../../../src/main/k8s/errors';

type Listener = (event: unknown, input: unknown) => Promise<unknown>;
const registered = new Map<string, Listener>();

const dialog = { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() };
const focused = { id: 1 };
vi.mock('electron', () => ({
    app: { getName: () => 'Kubermeister', getVersion: () => '0.1.1' },
    ipcMain: { handle: (channel: string, listener: Listener) => registered.set(channel, listener) },
    BrowserWindow: { getFocusedWindow: () => focused },
    dialog,
}));

const updater = {
    getUpdateState: vi.fn(),
    installUpdate: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    applyCheckInterval: vi.fn(),
};
const client = { reloadKubeConfig: vi.fn() };
const context = { listContexts: vi.fn(), getCurrentContext: vi.fn(), setContext: vi.fn(), setNamespace: vi.fn() };
const store = { getSettings: vi.fn(), updateSettings: vi.fn() };
const startup = { runStartupChecks: vi.fn() };
const resources = {
    listNamespaces: vi.fn(),
    getActiveNamespaceInfo: vi.fn(),
    getActiveCluster: vi.fn(),
    listClusters: vi.fn(),
};
const nodesMod = { listNodes: vi.fn(), getNode: vi.fn() };
const generic = { listResources: vi.fn(), getResource: vi.fn() };
const logsMod = { readPodLogSnapshot: vi.fn() };
const eventsMod = { listEventsForObject: vi.fn(), listRecentEvents: vi.fn(), listEvents: vi.fn() };
const overviewMod = { listQuotas: vi.fn(), listLimits: vi.fn() };
const metricsMod = {
    getSparklines: vi.fn(),
    getWorkloadHealth: vi.fn(),
    getPodSeries: vi.fn(),
    getNodeSeries: vi.fn(),
    getDeploymentSeries: vi.fn(),
};
const workloadsMod = { getDeploymentReplicaSets: vi.fn(), getDeploymentRollouts: vi.fn() };
const configMod = { getConfigMapEntries: vi.fn(), getSecretEntries: vi.fn(), revealSecretValue: vi.fn() };
const networkMod = { getServicePorts: vi.fn(), getServiceEndpoints: vi.fn(), getIngressRules: vi.fn() };
const helmMod = {
    listReleases: vi.fn(),
    getRelease: vi.fn(),
    getReleaseRevisions: vi.fn(),
    listHelmCharts: vi.fn(),
    rollbackRelease: vi.fn(),
    uninstallRelease: vi.fn(),
};
const chartsMod = {
    listChartRepositories: vi.fn(),
    addChartRepository: vi.fn(),
    refreshChartRepository: vi.fn(),
    removeChartRepository: vi.fn(),
};
const manifestMod = { getObjectYaml: vi.fn() };
const exportMod = { exportManifests: vi.fn() };
const fsMod = { writeFile: vi.fn() };
const writeMod = {
    createResource: vi.fn(),
    replaceResource: vi.fn(),
    deleteResource: vi.fn(),
    scaleResource: vi.fn(),
    restartResource: vi.fn(),
};
const lifecycleExtras = { updateAutoscaler: vi.fn() };
const lifecycleMod = {
    ...lifecycleExtras,
    evictPod: vi.fn(),
    retryJob: vi.fn(),
    triggerCronJob: vi.fn(),
    setCronJobSuspended: vi.fn(),
};
const ownersMod = { getPodOwners: vi.fn(), listOwnedPods: vi.fn() };
const describeMod = { describeObject: vi.fn() };
const schemasMod = { getKindSchema: vi.fn(), resetSchemaCache: vi.fn() };
const alertsMod = { listAlerts: vi.fn() };
const samplerMod = { resetHistory: vi.fn() };
const streamsMod = { endAllStreams: vi.fn() };
vi.mock('../../../src/main/k8s/sampler.js', () => samplerMod);
vi.mock('../../../src/main/ipc/streams.js', () => streamsMod);
vi.mock('../../../src/main/updater.js', () => updater);
vi.mock('../../../src/main/k8s/client.js', () => client);
vi.mock('../../../src/main/k8s/context.js', () => context);
vi.mock('../../../src/main/settings/store.js', () => store);
vi.mock('../../../src/main/startup/checks.js', () => startup);
vi.mock('../../../src/main/k8s/resources/cluster.js', () => resources);
vi.mock('../../../src/main/k8s/resources/nodes.js', () => nodesMod);
vi.mock('../../../src/main/k8s/resources/index.js', () => generic);
vi.mock('../../../src/main/k8s/logs.js', () => logsMod);
vi.mock('../../../src/main/k8s/resources/events.js', () => eventsMod);
vi.mock('../../../src/main/k8s/resources/metrics.js', () => metricsMod);
vi.mock('../../../src/main/k8s/alerts.js', () => alertsMod);
vi.mock('../../../src/main/k8s/resources/workloads.js', () => workloadsMod);
vi.mock('../../../src/main/k8s/resources/config.js', () => configMod);
vi.mock('../../../src/main/k8s/resources/overview.js', () => overviewMod);
vi.mock('../../../src/main/k8s/resources/network.js', () => networkMod);
vi.mock('../../../src/main/k8s/resources/helm.js', () => helmMod);
vi.mock('../../../src/main/charts/repositories.js', () => chartsMod);
vi.mock('../../../src/main/k8s/resources/manifest.js', () => manifestMod);
vi.mock('../../../src/main/k8s/resources/export.js', () => exportMod);
vi.mock('node:fs/promises', () => fsMod);
vi.mock('../../../src/main/k8s/resources/write.js', () => writeMod);
vi.mock('../../../src/main/k8s/resources/lifecycle.js', () => lifecycleMod);
vi.mock('../../../src/main/k8s/resources/owners.js', () => ownersMod);
vi.mock('../../../src/main/k8s/resources/describe.js', () => describeMod);
vi.mock('../../../src/main/k8s/openapi/index.js', () => schemasMod);

const { registerHandlers } = await import('../../../src/main/ipc/index.js');
const { ipcSchemas } = await import('../../../src/shared/ipc.js');

const alpha = { name: 'alpha', cluster: 'c', user: 'u', namespace: 'team-a', current: true };

async function invokeRaw(channel: string, input: unknown): Promise<unknown> {
    const listener = registered.get(channel);
    if (!listener) throw new Error(`no handler for ${channel}`);
    return listener({}, input);
}

/** Unwraps the `ok: true` envelope; failures surface as the envelope itself for inspection. */
async function invoke(channel: string, input: unknown): Promise<unknown> {
    const result = (await invokeRaw(channel, input)) as { ok: boolean; data?: unknown; error?: unknown };
    return result.ok ? result.data : result;
}

describe('registerHandlers', () => {
    // Under plain Node these two runtime versions do not exist; Electron always provides them.
    beforeAll(() => {
        Object.defineProperty(process.versions, 'electron', { value: '44.3.0', configurable: true });
        Object.defineProperty(process.versions, 'chrome', { value: '152.0.0.0', configurable: true });
    });
    afterAll(() => {
        delete (process.versions as Record<string, unknown>).electron;
        delete (process.versions as Record<string, unknown>).chrome;
    });

    beforeEach(() => {
        registered.clear();
        vi.clearAllMocks();
        store.getSettings.mockReturnValue(DEFAULT_SETTINGS);
        store.updateSettings.mockImplementation((patch) => mergeSettings(DEFAULT_SETTINGS, patch));
        registerHandlers();
    });

    it('registers one handler per channel in the contract', () => {
        expect([...registered.keys()].sort()).toEqual(Object.keys(ipcSchemas).sort());
    });

    it('answers app.info from the Electron runtime', async () => {
        await expect(invoke('app.info', {})).resolves.toEqual({
            name: 'Kubermeister',
            version: '0.1.1',
            electron: '44.3.0',
            chrome: '152.0.0.0',
            node: process.versions.node,
            platform: process.platform,
            arch: process.arch,
        });
    });

    it('passes the lifecycle writes straight through, each with the screen’s own stamp', async () => {
        const pod = { context: 'alpha', name: 'web-1', namespace: 'team-a' };
        const job = { context: 'alpha', name: 'import', namespace: 'team-a' };
        const cron = { context: 'alpha', name: 'nightly', namespace: 'team-a' };
        lifecycleMod.evictPod.mockResolvedValue({ kind: 'Pod', name: 'web-1', namespace: 'team-a' });
        lifecycleMod.retryJob.mockResolvedValue({ kind: 'Job', name: 'import', namespace: 'team-a' });
        lifecycleMod.triggerCronJob.mockResolvedValue({ kind: 'Job', name: 'nightly-1', namespace: 'team-a' });
        lifecycleMod.setCronJobSuspended.mockResolvedValue({ kind: 'CronJob', name: 'nightly', namespace: 'team-a' });

        await expect(invoke('pods.evict', pod)).resolves.toMatchObject({ kind: 'Pod' });
        await expect(invoke('jobs.retry', job)).resolves.toMatchObject({ kind: 'Job' });
        await expect(invoke('cronJobs.trigger', cron)).resolves.toMatchObject({ name: 'nightly-1' });
        await expect(invoke('cronJobs.suspend', { ...cron, suspend: true })).resolves.toMatchObject({
            kind: 'CronJob',
        });
        expect(lifecycleMod.evictPod).toHaveBeenCalledWith(pod);
        expect(lifecycleMod.setCronJobSuspended).toHaveBeenCalledWith({ ...cron, suspend: true });
    });

    it('answers the ownership reads for the object the screen names', async () => {
        ownersMod.getPodOwners.mockResolvedValue([
            { kind: 'Deployment', name: 'web', namespace: 'team-a', path: '/workloads/deployments/team-a/web' },
        ]);
        ownersMod.listOwnedPods.mockResolvedValue([]);
        await expect(invoke('pods.owners', { name: 'web-1', namespace: 'team-a' })).resolves.toHaveLength(1);
        await expect(
            invoke('workloads.pods', { kind: 'Deployment', name: 'web', namespace: 'team-a' }),
        ).resolves.toEqual([]);
        expect(ownersMod.getPodOwners).toHaveBeenCalledWith('web-1', 'team-a');
        expect(ownersMod.listOwnedPods).toHaveBeenCalledWith('Deployment', 'web', 'team-a');
    });

    it('passes the remaining writes and the describe read straight through', async () => {
        const target = { context: 'alpha', name: 'web', namespace: 'team-a' };
        writeMod.restartResource.mockResolvedValue({ kind: 'Deployment', name: 'web', namespace: 'team-a' });
        lifecycleMod.updateAutoscaler.mockResolvedValue({
            kind: 'HorizontalPodAutoscaler',
            name: 'web',
            namespace: 'team-a',
        });
        helmMod.rollbackRelease.mockResolvedValue({
            name: 'demo',
            namespace: 'team-a',
            revision: 3,
            removed: 0,
            kept: 0,
        });
        helmMod.uninstallRelease.mockResolvedValue({ name: 'demo', namespace: 'team-a', removed: 2, kept: 1 });
        describeMod.describeObject.mockResolvedValue({ kind: 'Pod', name: 'web-1', namespace: 'team-a', sections: [] });

        await expect(invoke('resources.restart', { ...target, kind: 'Deployment' })).resolves.toMatchObject({
            kind: 'Deployment',
        });
        await expect(
            invoke('autoscalers.update', { ...target, minReplicas: 1, maxReplicas: 3 }),
        ).resolves.toMatchObject({ kind: 'HorizontalPodAutoscaler' });
        await expect(invoke('releases.rollback', { ...target, name: 'demo', revision: 1 })).resolves.toMatchObject({
            revision: 3,
        });
        await expect(
            invoke('releases.uninstall', { ...target, name: 'demo', keepHistory: false }),
        ).resolves.toMatchObject({ kept: 1 });
        await expect(
            invoke('resources.describe', { kind: 'Pod', name: 'web-1', namespace: 'team-a' }),
        ).resolves.toMatchObject({ kind: 'Pod' });
    });

    it('rejects input that does not match the channel schema', async () => {
        await expect(invoke('app.info', 'not-an-object')).rejects.toThrow();
        await expect(invoke('context.set', { name: '' })).rejects.toThrow();
        expect(context.setContext).not.toHaveBeenCalled();
    });

    it('rejects handler output that does not match the channel schema', async () => {
        updater.getUpdateState.mockReturnValue({ status: 'exploded' });
        await expect(invoke('update.state', {})).rejects.toThrow();
    });

    it('forwards the update channels to the updater', async () => {
        updater.getUpdateState.mockReturnValue({ status: 'downloaded', version: '0.2.0' });
        updater.installUpdate.mockReturnValue(true);
        updater.checkForUpdates.mockResolvedValue({ status: 'up-to-date', checkedAt: '2026-09-16T07:00:00.000Z' });
        updater.downloadUpdate.mockReturnValue(false);
        await expect(invoke('update.state', {})).resolves.toEqual({ status: 'downloaded', version: '0.2.0' });
        await expect(invoke('update.check', {})).resolves.toEqual({
            status: 'up-to-date',
            checkedAt: '2026-09-16T07:00:00.000Z',
        });
        await expect(invoke('update.download', {})).resolves.toEqual({ ok: false });
        await expect(invoke('update.install', {})).resolves.toEqual({ ok: true });
    });

    it('forwards the connection channels to the context module', async () => {
        context.listContexts.mockReturnValue([alpha]);
        context.getCurrentContext.mockReturnValue(alpha);
        context.setContext.mockReturnValue({ ...alpha, name: 'beta' });
        context.setNamespace.mockReturnValue({ namespace: 'x' });
        await expect(invoke('contexts.list', {})).resolves.toEqual([alpha]);
        await expect(invoke('context.current', {})).resolves.toEqual(alpha);
        await expect(invoke('context.set', { name: 'beta' })).resolves.toMatchObject({ name: 'beta' });
        expect(context.setContext).toHaveBeenCalledWith('beta');
        await expect(invoke('namespace.set', { namespace: 'x' })).resolves.toEqual({ namespace: 'x' });
        expect(context.setNamespace).toHaveBeenCalledWith('x');
    });

    it('ends every live stream and drops sampled usage before a context switch takes effect', async () => {
        const order: string[] = [];
        streamsMod.endAllStreams.mockImplementation(() => order.push('streams'));
        samplerMod.resetHistory.mockImplementation(() => order.push('sampler'));
        schemasMod.resetSchemaCache.mockImplementation(() => order.push('schemas'));
        context.setContext.mockImplementation(() => {
            order.push('switch');
            return { ...alpha, name: 'beta' };
        });
        await invoke('context.set', { name: 'beta' });
        expect(order).toEqual(['streams', 'sampler', 'schemas', 'switch']);
        expect(streamsMod.endAllStreams).toHaveBeenCalledWith('The context changed to "beta"');
        // A namespace switch changes nothing about the connection, so streams stay up.
        await invoke('namespace.set', { namespace: 'x' });
        expect(streamsMod.endAllStreams).toHaveBeenCalledOnce();
    });

    it('answers a kind’s schema, and refuses a group-version that could leave the OpenAPI endpoint', async () => {
        schemasMod.getKindSchema.mockResolvedValue({
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            document: 'apis/apps/v1',
            name: 'io.k8s.api.apps.v1.Deployment',
            definitions: { 'io.k8s.api.apps.v1.Deployment': { type: 'object' } },
        });
        await expect(invoke('schemas.forKind', { apiVersion: 'apps/v1', kind: 'Deployment' })).resolves.toMatchObject({
            name: 'io.k8s.api.apps.v1.Deployment',
        });
        expect(schemasMod.getKindSchema).toHaveBeenCalledWith({ apiVersion: 'apps/v1', kind: 'Deployment' });

        schemasMod.getKindSchema.mockResolvedValue(null);
        await expect(invoke('schemas.forKind', { apiVersion: 'example.com/v1', kind: 'Widget' })).resolves.toBeNull();
        await expect(invoke('schemas.forKind', { apiVersion: '../secrets', kind: 'Widget' })).rejects.toThrow();
    });

    it('refuses a malformed namespace before it can become the active selection', async () => {
        for (const namespace of ['', 'Team-A', 'a b', 'ns/other']) {
            await expect(invoke('namespace.set', { namespace })).rejects.toThrow();
        }
        expect(context.setNamespace).not.toHaveBeenCalled();
    });

    it('runs the startup checks', async () => {
        startup.runStartupChecks.mockResolvedValue({ checks: [], ok: true });
        await expect(invoke('startupChecks', {})).resolves.toEqual({ checks: [], ok: true });
    });

    it('reads and patches settings, refusing a kubeconfig path from the renderer', async () => {
        await expect(invoke('settings.get', {})).resolves.toEqual(DEFAULT_SETTINGS);
        await invoke('settings.set', { session: { lastNamespace: 'ns' } });
        expect(store.updateSettings).toHaveBeenCalledWith({ session: { lastNamespace: 'ns' } });
        await invoke('settings.set', { connection: { kubeconfigPath: '/etc/passwd' } });
        expect(store.updateSettings).toHaveBeenLastCalledWith({});
    });

    it('hands the update check interval to the updater on every settings write', async () => {
        updater.applyCheckInterval.mockClear();
        await invoke('settings.set', { updates: { checkIntervalHours: 12 } });
        expect(updater.applyCheckInterval).toHaveBeenCalledWith(12);
    });

    it('applies a new read timeout to every cluster call the moment it is saved', async () => {
        try {
            await invoke('settings.set', { data: { readTimeoutSec: 300 } });
            expect(readTimeoutMs()).toBe(300_000);
        } finally {
            setReadTimeoutSec(DEFAULT_SETTINGS.data.readTimeoutSec);
        }
    });

    it('applies a picked kubeconfig path and reloads the client', async () => {
        dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/home/u/.kube/other'] });
        await expect(invoke('kubeconfig.pick', {})).resolves.toEqual({ path: '/home/u/.kube/other' });
        expect(dialog.showOpenDialog).toHaveBeenCalledWith(
            focused,
            expect.objectContaining({ properties: ['openFile', 'showHiddenFiles'] }),
        );
        expect(store.updateSettings).toHaveBeenCalledWith({ connection: { kubeconfigPath: '/home/u/.kube/other' } });
        expect(client.reloadKubeConfig).toHaveBeenCalledOnce();
        // Streams and sampled usage belong to the kubeconfig that was just left.
        expect(streamsMod.endAllStreams).toHaveBeenCalledWith('The kubeconfig changed');
        expect(samplerMod.resetHistory).toHaveBeenCalledOnce();
    });

    it('reloads the connection when the proxy or the CA bundle changes, and only then', async () => {
        await invoke('settings.set', { data: { refreshIntervalSec: 30 } });
        expect(client.reloadKubeConfig).not.toHaveBeenCalled();
        // Writing the value it already had is not a change either.
        await invoke('settings.set', { network: { proxyMode: 'env' } });
        expect(client.reloadKubeConfig).not.toHaveBeenCalled();

        await invoke('settings.set', { network: { proxyMode: 'manual', proxyUrl: 'http://proxy:3128' } });
        expect(client.reloadKubeConfig).toHaveBeenCalledOnce();
        // Every stream was made on the old route to the cluster.
        expect(streamsMod.endAllStreams).toHaveBeenCalledWith('The proxy settings changed');
        expect(samplerMod.resetHistory).toHaveBeenCalledOnce();
    });

    it('picks a CA bundle through the native dialog and reloads the client', async () => {
        dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/etc/corp/ca.pem'] });
        await expect(invoke('caBundle.pick', {})).resolves.toEqual({ path: '/etc/corp/ca.pem' });
        expect(store.updateSettings).toHaveBeenCalledWith({ network: { caBundlePath: '/etc/corp/ca.pem' } });
        expect(client.reloadKubeConfig).toHaveBeenCalledOnce();
        expect(streamsMod.endAllStreams).toHaveBeenCalledWith('The proxy settings changed');
    });

    it('leaves the CA bundle alone when its picker is cancelled', async () => {
        dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
        await expect(invoke('caBundle.pick', {})).resolves.toEqual({ path: null });
        expect(store.updateSettings).not.toHaveBeenCalled();
        expect(client.reloadKubeConfig).not.toHaveBeenCalled();
    });

    it('clears the CA bundle and reloads', async () => {
        await expect(invoke('caBundle.clear', {})).resolves.toMatchObject({ network: { caBundlePath: null } });
        expect(store.updateSettings).toHaveBeenCalledWith({ network: { caBundlePath: null } });
        expect(client.reloadKubeConfig).toHaveBeenCalledOnce();
        expect(streamsMod.endAllStreams).toHaveBeenCalledWith('The proxy settings changed');
    });

    it('saves a selection to the file the user names, having read the objects first', async () => {
        const order: string[] = [];
        exportMod.exportManifests.mockImplementation(async () => {
            order.push('read');
            return { text: 'apiVersion: v1\nkind: ConfigMap\n', count: 2, defaultName: 'configmap-export.yaml' };
        });
        dialog.showSaveDialog.mockImplementation(async () => {
            order.push('dialog');
            return { canceled: false, filePath: '/home/u/manifests.yaml' };
        });
        const input = {
            kind: 'ConfigMap',
            clean: true,
            targets: [
                { name: 'app-config', namespace: 'team-a' },
                { name: 'other-config', namespace: 'team-a' },
            ],
        };
        await expect(invoke('resources.exportYaml', input)).resolves.toEqual({
            path: '/home/u/manifests.yaml',
            count: 2,
        });
        expect(exportMod.exportManifests).toHaveBeenCalledWith(input);
        // A cluster that will not answer says so before the user is asked to name a file.
        expect(order).toEqual(['read', 'dialog']);
        expect(dialog.showSaveDialog).toHaveBeenCalledWith(
            focused,
            expect.objectContaining({ defaultPath: 'configmap-export.yaml' }),
        );
        expect(fsMod.writeFile).toHaveBeenCalledWith(
            '/home/u/manifests.yaml',
            'apiVersion: v1\nkind: ConfigMap\n',
            'utf8',
        );
    });

    it('writes nothing when the save dialog is dismissed', async () => {
        exportMod.exportManifests.mockResolvedValue({ text: 'x', count: 1, defaultName: 'web.yaml' });
        dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
        await expect(
            invoke('resources.exportYaml', {
                kind: 'ConfigMap',
                clean: false,
                targets: [{ name: 'app-config', namespace: 'team-a' }],
            }),
        ).resolves.toEqual({ path: null, count: 0 });
        expect(fsMod.writeFile).not.toHaveBeenCalled();
    });

    it('reports a file that could not be written as a failure rather than a bug', async () => {
        exportMod.exportManifests.mockResolvedValue({ text: 'x', count: 1, defaultName: 'web.yaml' });
        dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/read-only/web.yaml' });
        fsMod.writeFile.mockRejectedValue(new Error('EACCES: permission denied'));
        await expect(
            invokeRaw('resources.exportYaml', {
                kind: 'ConfigMap',
                clean: false,
                targets: [{ name: 'app-config', namespace: 'team-a' }],
            }),
        ).resolves.toMatchObject({
            ok: false,
            error: { kind: 'unknown', detail: 'The file could not be saved: EACCES: permission denied' },
        });
    });

    it('refuses a selection whose targets do not match the kind\u2019s scope', async () => {
        // The namespace of every target is checked at the boundary, as it is for every other target.
        await expect(
            invoke('resources.exportYaml', { kind: 'ConfigMap', clean: false, targets: [{ name: 'app-config' }] }),
        ).rejects.toThrow();
        await expect(
            invoke('resources.exportYaml', {
                kind: 'PersistentVolume',
                clean: false,
                targets: [{ name: 'pv-1', namespace: 'team-a' }],
            }),
        ).rejects.toThrow();
        await expect(
            invoke('resources.exportYaml', { kind: 'ConfigMap', clean: false, targets: [] }),
        ).rejects.toThrow();
        expect(exportMod.exportManifests).not.toHaveBeenCalled();
    });

    it('leaves settings alone when the picker is cancelled', async () => {
        dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
        await expect(invoke('kubeconfig.pick', {})).resolves.toEqual({ path: null });
        expect(store.updateSettings).not.toHaveBeenCalled();
        expect(client.reloadKubeConfig).not.toHaveBeenCalled();
    });

    it('wraps successes in the ok envelope', async () => {
        await expect(invokeRaw('settings.get', {})).resolves.toEqual({ ok: true, data: DEFAULT_SETTINGS });
    });

    it('turns a classified cluster failure into an ok:false envelope instead of rejecting', async () => {
        nodesMod.listNodes.mockRejectedValue(new K8sError('forbidden', 'Access denied (RBAC).', 'nodes.list'));
        await expect(invokeRaw('nodes.list', {})).resolves.toEqual({
            ok: false,
            error: { kind: 'forbidden', detail: 'Access denied (RBAC).', op: 'nodes.list' },
        });
    });

    it('still rejects on unexpected exceptions', async () => {
        nodesMod.listNodes.mockRejectedValue(new TypeError('bug'));
        await expect(invokeRaw('nodes.list', {})).rejects.toThrow('bug');
    });

    it('forwards the cluster, namespace and node channels', async () => {
        const namespace = { name: 'team-a', tone: 'accent' };
        const clusterInfo = {
            name: 'alpha',
            nodes: 1,
            status: 'Healthy',
            version: '1.36.4',
            provider: 'k3s',
            region: '—',
        };
        const nodeRow = {
            name: 'n1',
            status: 'Ready',
            role: 'worker',
            version: 'v1',
            cpu: 4,
            memory: 7.8,
            cpuUsed: 25,
            memUsed: null,
            age: '3d',
            instanceType: '—',
        };
        resources.listNamespaces.mockResolvedValue([namespace]);
        resources.getActiveNamespaceInfo.mockResolvedValue({ name: namespace.name });
        resources.getActiveCluster.mockResolvedValue(clusterInfo);
        resources.listClusters.mockResolvedValue([clusterInfo]);
        nodesMod.listNodes.mockResolvedValue([nodeRow]);
        nodesMod.getNode.mockResolvedValue(null);
        await expect(invoke('namespaces.list', {})).resolves.toEqual([namespace]);
        await expect(invoke('namespace.active', {})).resolves.toEqual({ name: namespace.name });
        await expect(invoke('cluster.active', {})).resolves.toEqual(clusterInfo);
        await expect(invoke('clusters.list', {})).resolves.toEqual([clusterInfo]);
        await expect(invoke('nodes.list', {})).resolves.toEqual([nodeRow]);
        await expect(invoke('nodes.get', { name: 'missing' })).resolves.toBeNull();
        expect(nodesMod.getNode).toHaveBeenCalledWith('missing');
    });

    it('forwards the generic resource channels and validates the kind', async () => {
        const row = {
            name: 'web-1',
            namespace: 'team-a',
            status: 'Running',
            ready: '1/1',
            restarts: 0,
            age: '3d',
            node: 'n1',
            owner: 'ReplicaSet/web-7d9',
            cpu: 0,
            mem: 0,
            cpuLimit: 0,
            memLimit: 0,
        };
        generic.listResources.mockResolvedValue({ kind: 'Pod', items: [row] });
        generic.getResource.mockResolvedValue({ kind: 'Pod', item: null });
        await expect(invoke('resources.list', { kind: 'Pod' })).resolves.toEqual({ kind: 'Pod', items: [row] });
        await expect(invoke('resources.get', { kind: 'Pod', name: 'web-1', namespace: 'team-a' })).resolves.toEqual({
            kind: 'Pod',
            item: null,
        });
        await expect(invoke('resources.list', { kind: 'Nope' })).rejects.toThrow();
    });

    it('forwards the log snapshot and object events channels with their inputs', async () => {
        const line = { timestamp: 't', message: 'm' };
        logsMod.readPodLogSnapshot.mockResolvedValue([line]);
        await expect(
            invoke('pods.logSnapshot', { name: 'web-1', namespace: 'team-a', container: 'app', sinceSeconds: 300 }),
        ).resolves.toEqual([line]);
        expect(logsMod.readPodLogSnapshot).toHaveBeenCalledWith({
            name: 'web-1',
            namespace: 'team-a',
            container: 'app',
            sinceSeconds: 300,
        });
        await expect(invoke('pods.logSnapshot', { name: 'web-1' })).rejects.toThrow();

        const ev = { time: '12:00:00', type: 'Warning', reason: 'BackOff', object: 'pod/web-1', message: 'x' };
        eventsMod.listEventsForObject.mockResolvedValue([ev]);
        await expect(invoke('events.forObject', { kind: 'Pod', name: 'web-1', namespace: 'team-a' })).resolves.toEqual([
            ev,
        ]);
        await expect(invoke('events.forObject', { kind: '', name: 'web-1' })).rejects.toThrow();
        eventsMod.listRecentEvents.mockResolvedValue([ev]);
        await expect(invoke('events.recent', {})).resolves.toEqual([ev]);
    });

    it('forwards the metrics channels and validates their inputs', async () => {
        metricsMod.getSparklines.mockResolvedValue({ nodes: [1], cpu: [10], mem: [20] });
        metricsMod.getWorkloadHealth.mockResolvedValue([{ t: 1, cpu: 10, mem: 20 }]);
        metricsMod.getPodSeries.mockResolvedValue({ cpu: [1], mem: [2] });
        metricsMod.getNodeSeries.mockResolvedValue({ cpu: [3], mem: [4] });
        alertsMod.listAlerts.mockResolvedValue([{ tone: 'warn', title: 't', detail: 'd' }]);
        await expect(invoke('metrics.sparklines', {})).resolves.toEqual({ nodes: [1], cpu: [10], mem: [20] });
        await expect(invoke('metrics.workloadHealth', {})).resolves.toEqual([{ t: 1, cpu: 10, mem: 20 }]);
        await expect(invoke('metrics.alerts', {})).resolves.toEqual([{ tone: 'warn', title: 't', detail: 'd' }]);
        await expect(invoke('metrics.podSeries', { namespace: 'team-a', name: 'web-1' })).resolves.toEqual({
            cpu: [1],
            mem: [2],
        });
        expect(metricsMod.getPodSeries).toHaveBeenCalledWith('team-a', 'web-1');
        await expect(invoke('metrics.nodeSeries', { name: 'n1' })).resolves.toEqual({ cpu: [3], mem: [4] });
        await expect(invoke('metrics.podSeries', { name: 'web-1' })).rejects.toThrow();
    });

    it('forwards the deployment extras and their series', async () => {
        const rs = { name: 'web-1', desired: 1, current: 1, ready: 1, age: '1h' };
        const rollout = { rev: '1', state: 'Current', image: 'x', by: '—', when: '1h ago', duration: '1h' };
        workloadsMod.getDeploymentReplicaSets.mockResolvedValue([rs]);
        workloadsMod.getDeploymentRollouts.mockResolvedValue([rollout]);
        metricsMod.getDeploymentSeries.mockResolvedValue({ cpu: [1], mem: [2] });
        await expect(invoke('deployments.replicaSets', { name: 'web', namespace: 'team-a' })).resolves.toEqual([rs]);
        expect(workloadsMod.getDeploymentReplicaSets).toHaveBeenCalledWith('web', 'team-a');
        await expect(invoke('deployments.rollouts', { name: 'web', namespace: 'team-a' })).resolves.toEqual([rollout]);
        await expect(invoke('metrics.deploymentSeries', { namespace: 'team-a', name: 'web' })).resolves.toEqual({
            cpu: [1],
            mem: [2],
        });
        expect(metricsMod.getDeploymentSeries).toHaveBeenCalledWith('team-a', 'web');
        await expect(invoke('deployments.rollouts', { name: 'web' })).rejects.toThrow();
    });

    it('forwards the config map and secret entry channels', async () => {
        configMod.getConfigMapEntries.mockResolvedValue([
            { key: 'greeting', contentType: 'text/plain', size: '5 B', value: 'hello' },
        ]);
        configMod.getSecretEntries.mockResolvedValue([{ key: 'password', masked: '••••••••' }]);
        await expect(invoke('configMaps.entries', { name: 'app-config', namespace: 'team-a' })).resolves.toEqual([
            { key: 'greeting', contentType: 'text/plain', size: '5 B', value: 'hello' },
        ]);
        expect(configMod.getConfigMapEntries).toHaveBeenCalledWith('app-config', 'team-a');
        await expect(invoke('secrets.entries', { name: 'app-secret', namespace: 'team-a' })).resolves.toEqual([
            { key: 'password', masked: '••••••••' },
        ]);
        await expect(invoke('secrets.entries', { name: 'app-secret' })).rejects.toThrow();
    });

    it('reveals one secret key by name and refuses a request without one', async () => {
        configMod.revealSecretValue.mockResolvedValue({ key: 'password', value: 'super-secret', binary: false });
        await expect(
            invoke('secrets.reveal', { name: 'app-secret', namespace: 'team-a', key: 'password' }),
        ).resolves.toEqual({ key: 'password', value: 'super-secret', binary: false });
        expect(configMod.revealSecretValue).toHaveBeenCalledWith('app-secret', 'team-a', 'password');
        await expect(invoke('secrets.reveal', { name: 'app-secret', namespace: 'team-a', key: '' })).rejects.toThrow();
        await expect(invoke('secrets.reveal', { name: 'app-secret', namespace: 'team-a' })).rejects.toThrow();
    });

    it('forwards the overview list channels with their namespace scope', async () => {
        const ev = { time: '12:00:00', type: 'Normal', reason: 'r', object: 'pod/x', message: 'm' };
        eventsMod.listEvents.mockResolvedValue([ev]);
        overviewMod.listQuotas.mockResolvedValue([]);
        overviewMod.listLimits.mockResolvedValue([]);
        await expect(invoke('events.list', { namespace: 'team-a' })).resolves.toEqual([ev]);
        expect(eventsMod.listEvents).toHaveBeenCalledWith('team-a');
        await expect(invoke('quotas.list', {})).resolves.toEqual([]);
        expect(overviewMod.listQuotas).toHaveBeenCalledWith(undefined);
        await expect(invoke('limits.list', {})).resolves.toEqual([]);
        await expect(invoke('quotas.list', { namespace: '' })).rejects.toThrow();
    });

    it('forwards the service and ingress sub-reads', async () => {
        networkMod.getServicePorts.mockResolvedValue([
            { name: 'http', port: '80', protocol: 'TCP', target: '8080', appProtocol: '—' },
        ]);
        networkMod.getServiceEndpoints.mockResolvedValue([
            { pod: 'web-1', node: 'n1', address: '10.0.0.1', ready: 'Ready' },
        ]);
        networkMod.getIngressRules.mockResolvedValue([{ host: 'h', path: '/', backend: 'web', port: '80' }]);
        await expect(invoke('services.ports', { name: 'web', namespace: 'team-a' })).resolves.toHaveLength(1);
        expect(networkMod.getServicePorts).toHaveBeenCalledWith('web', 'team-a');
        await expect(invoke('services.endpoints', { name: 'web', namespace: 'team-a' })).resolves.toHaveLength(1);
        await expect(invoke('ingresses.rules', { name: 'web', namespace: 'team-a' })).resolves.toHaveLength(1);
        await expect(invoke('services.ports', { name: 'web' })).rejects.toThrow();
    });

    it('forwards the helm release reads and rejects a nameless target', async () => {
        const release = {
            name: 'traefik',
            namespace: 'kube-system',
            chart: 'traefik-28.0.0',
            revision: 2,
            status: 'Deployed',
            updated: '1h ago',
        };
        helmMod.listReleases.mockResolvedValue([release]);
        helmMod.getRelease.mockResolvedValue(release);
        helmMod.getReleaseRevisions.mockResolvedValue([
            { rev: '2', status: 'Deployed', chartVersion: '28.0.0', updated: '1h ago', description: 'Upgrade' },
        ]);
        helmMod.listHelmCharts.mockResolvedValue([
            { name: 'traefik', repository: '—', latestVersion: '28.0.0', appVersion: '3.0.0', description: '' },
        ]);
        await expect(invoke('releases.list', {})).resolves.toHaveLength(1);
        await expect(invoke('releases.get', { name: 'traefik', namespace: 'kube-system' })).resolves.toMatchObject({
            revision: 2,
        });
        expect(helmMod.getRelease).toHaveBeenCalledWith('traefik', 'kube-system');
        await expect(invoke('releases.revisions', { name: 'traefik', namespace: 'kube-system' })).resolves.toHaveLength(
            1,
        );
        expect(helmMod.getReleaseRevisions).toHaveBeenCalledWith('traefik', 'kube-system');
        await expect(invoke('helmCharts.list', {})).resolves.toHaveLength(1);
        await expect(invoke('releases.get', { name: '', namespace: 'kube-system' })).rejects.toThrow();
        // A release is looked up where its screen says it is, so the namespace is not optional.
        await expect(invoke('releases.get', { name: 'traefik' })).rejects.toThrow();
    });

    it('forwards the chart repository calls and refuses an input the contract does not allow', async () => {
        const status = {
            name: 'bitnami',
            kind: 'classic',
            url: 'https://charts.example.com',
            hasCredentials: false,
            chartCount: 12,
            refreshedAt: '2026-09-22T10:00:00.000Z',
        };
        chartsMod.listChartRepositories.mockResolvedValue([status]);
        chartsMod.addChartRepository.mockResolvedValue(status);
        chartsMod.refreshChartRepository.mockResolvedValue(status);
        chartsMod.removeChartRepository.mockResolvedValue({ name: 'bitnami' });

        await expect(invoke('chartRepositories.list', {})).resolves.toHaveLength(1);
        const input = { name: 'bitnami', kind: 'classic', url: 'https://charts.example.com' };
        await expect(invoke('chartRepositories.add', input)).resolves.toMatchObject({ chartCount: 12 });
        expect(chartsMod.addChartRepository).toHaveBeenCalledWith(input);
        await expect(invoke('chartRepositories.refresh', { name: 'bitnami' })).resolves.toBeTruthy();
        expect(chartsMod.refreshChartRepository).toHaveBeenCalledWith('bitnami');
        await expect(invoke('chartRepositories.remove', { name: 'bitnami' })).resolves.toEqual({ name: 'bitnami' });
        expect(chartsMod.removeChartRepository).toHaveBeenCalledWith('bitnami');

        // A name that could leave the index cache directory, and a URL the kind is never served at.
        await expect(invoke('chartRepositories.refresh', { name: '../escape' })).rejects.toThrow();
        await expect(invoke('chartRepositories.add', { ...input, url: 'oci://ghcr.io/x' })).rejects.toThrow();
        // A password bound for a plaintext repository never leaves the renderer.
        await expect(
            invoke('chartRepositories.add', {
                ...input,
                url: 'http://charts.example.com',
                username: 'ara',
                password: 'hunter2',
            }),
        ).rejects.toThrow();
        expect(chartsMod.addChartRepository).toHaveBeenCalledOnce();
    });

    it('forwards the manifest read and rejects an unknown kind', async () => {
        manifestMod.getObjectYaml.mockResolvedValue({ yaml: 'kind: Pod\n', kind: 'Pod', namespace: 'team-a' });
        await expect(
            invoke('resources.getYaml', { kind: 'Pod', name: 'web-1', namespace: 'team-a' }),
        ).resolves.toMatchObject({ kind: 'Pod' });
        expect(manifestMod.getObjectYaml).toHaveBeenCalledWith('Pod', 'web-1', 'team-a');
        // Nodes are not a registered kind but their manifest is readable all the same.
        await expect(invoke('resources.getYaml', { kind: 'Node', name: 'node-1' })).resolves.toBeTruthy();
        await expect(invoke('resources.getYaml', { kind: 'ReplicaSet', name: 'web' })).rejects.toThrow();
        await expect(invoke('resources.getYaml', { kind: 'Pod', name: '' })).rejects.toThrow();
    });

    it('forwards the writes and rejects inputs the contract refuses', async () => {
        const result = { kind: 'ConfigMap', name: 'app-config', namespace: 'team-a' };
        writeMod.createResource.mockResolvedValue(result);
        writeMod.replaceResource.mockResolvedValue(result);
        writeMod.deleteResource.mockResolvedValue(result);
        writeMod.scaleResource.mockResolvedValue({ kind: 'Deployment', name: 'web', namespace: 'team-a' });

        const create = { context: 'alpha', manifest: 'kind: ConfigMap' };
        await expect(invoke('resources.create', create)).resolves.toMatchObject(result);
        expect(writeMod.createResource).toHaveBeenCalledWith(create);
        const replace = { context: 'alpha', manifest: 'kind: ConfigMap', dryRun: true };
        await expect(invoke('resources.replace', replace)).resolves.toBeTruthy();
        expect(writeMod.replaceResource).toHaveBeenCalledWith(replace);
        const del = { context: 'alpha', kind: 'ConfigMap', name: 'app-config', namespace: 'team-a' };
        await expect(invoke('resources.delete', del)).resolves.toBeTruthy();
        expect(writeMod.deleteResource).toHaveBeenCalledWith(del);
        const scale = { context: 'alpha', kind: 'Deployment', name: 'web', namespace: 'team-a', replicas: 3 };
        await expect(invoke('resources.scale', scale)).resolves.toBeTruthy();
        expect(writeMod.scaleResource).toHaveBeenCalledWith(scale);

        await expect(invoke('resources.create', { context: 'alpha', manifest: '' })).rejects.toThrow();
        // Without the context stamp main cannot tell which cluster the screen meant.
        await expect(invoke('resources.create', { manifest: 'kind: ConfigMap' })).rejects.toThrow();
        // A namespaced kind must name its namespace; the active one is never assumed for a write.
        await expect(invoke('resources.delete', { ...del, namespace: undefined })).rejects.toThrow();
        await expect(invoke('resources.scale', { ...scale, namespace: undefined })).rejects.toThrow();
        await expect(invoke('resources.scale', { ...scale, replicas: -1 })).rejects.toThrow();
        // A node has no scale subresource and is not a registered kind, so the contract refuses it.
        await expect(invoke('resources.scale', { ...scale, kind: 'Node', name: 'node-1' })).rejects.toThrow();
        expect(writeMod.deleteResource).toHaveBeenCalledOnce();
        expect(writeMod.scaleResource).toHaveBeenCalledOnce();
    });

    it('resets to the default kubeconfig and reloads', async () => {
        await expect(invoke('kubeconfig.useDefault', {})).resolves.toMatchObject({
            connection: { kubeconfigPath: null },
        });
        expect(store.updateSettings).toHaveBeenCalledWith({ connection: { kubeconfigPath: null } });
        expect(client.reloadKubeConfig).toHaveBeenCalledOnce();
        expect(streamsMod.endAllStreams).toHaveBeenCalledWith('The kubeconfig changed');
        expect(samplerMod.resetHistory).toHaveBeenCalledOnce();
    });
});
