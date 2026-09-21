import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcChannel, IpcInput, IpcOutput, IpcResult } from '../../shared/ipc.js';
import { ipcSchemas } from '../../shared/ipc.js';
import { reloadKubeConfig } from '../k8s/client.js';
import { getCurrentContext, listContexts, setContext, setNamespace } from '../k8s/context.js';
import { K8sError, setReadTimeoutSec } from '../k8s/errors.js';
import { listAlerts } from '../k8s/alerts.js';
import { resetHistory } from '../k8s/sampler.js';
import { endAllStreams } from './streams.js';
import { stopAllInformers } from '../k8s/watch.js';
import { readPodLogSnapshot, readPodLogText } from '../k8s/logs.js';
import { getActiveCluster, getActiveNamespaceInfo, listClusters, listNamespaces } from '../k8s/resources/cluster.js';
import { getConfigMapEntries, getSecretEntries, revealSecretValue } from '../k8s/resources/config.js';
import { listEvents, listEventsForObject, listRecentEvents } from '../k8s/resources/events.js';
import {
    createResource,
    deleteResource,
    replaceResource,
    restartResource,
    scaleResource,
} from '../k8s/resources/write.js';
import { getObjectYaml } from '../k8s/resources/manifest.js';
import { getObjectMeta } from '../k8s/resources/meta.js';
import { getRelated } from '../k8s/resources/related.js';
import { getNamespaceDetail } from '../k8s/resources/namespaces.js';
import {
    getCustomResourceInstance,
    getCustomResourceYaml,
    listCustomResourceInstances,
} from '../k8s/resources/custom.js';
import { describeObject } from '../k8s/resources/describe.js';
import { getPodOwners, listOwnedPods } from '../k8s/resources/owners.js';
import {
    evictPod,
    retryJob,
    setCronJobSuspended,
    triggerCronJob,
    updateAutoscaler,
} from '../k8s/resources/lifecycle.js';
import {
    getRelease,
    getReleaseRevisions,
    listHelmCharts,
    listReleases,
    rollbackRelease,
    uninstallRelease,
} from '../k8s/resources/helm.js';
import { getIngressRules, getServiceEndpoints, getServicePorts } from '../k8s/resources/network.js';
import { listLimits, listQuotas } from '../k8s/resources/overview.js';
import {
    getDeploymentSeries,
    getNodeSeries,
    getPodSeries,
    getSparklines,
    getWorkloadHealth,
} from '../k8s/resources/metrics.js';
import {
    getDeploymentReplicaSets,
    getDeploymentRolloutStatus,
    getDeploymentRollouts,
    rollbackDeployment,
    compareDeploymentRevisions,
    setDeploymentPaused,
} from '../k8s/resources/workloads.js';
import { getResource, listResources } from '../k8s/resources/index.js';
import { getDrainPlan } from '../k8s/drain.js';
import { cordonNode, getNode, listNodes } from '../k8s/resources/nodes.js';
import type { Settings } from '../../shared/settings.js';
import { getSettings, updateSettings } from '../settings/store.js';
import { runStartupChecks } from '../startup/checks.js';
import { applyCheckInterval, checkForUpdates, downloadUpdate, getUpdateState, installUpdate } from '../updater.js';

type Handler<C extends IpcChannel> = (input: IpcInput<C>) => Promise<IpcOutput<C>>;
type Handlers = { [C in IpcChannel]: Handler<C> };

/**
 * Point the app at a different kubeconfig through the native file dialog. The path comes from the
 * OS picker, never from the renderer, so a compromised renderer cannot make the app read an
 * arbitrary file or run an exec credential plugin from one.
 */
async function pickKubeconfig(): Promise<string | null> {
    const owner = BrowserWindow.getFocusedWindow() ?? undefined;
    const options: Electron.OpenDialogOptions = {
        title: 'Choose a kubeconfig file',
        properties: ['openFile', 'showHiddenFiles'],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const path = result.canceled ? undefined : result.filePaths[0];
    if (!path) return null;
    updateSettings({ connection: { kubeconfigPath: path } });
    leaveConnection('The kubeconfig changed');
    reloadKubeConfig();
    return path;
}

/**
 * Point the app at a bundle of extra certificate authorities, through the same native dialog the
 * kubeconfig uses and for the same reason: a path the renderer supplied would be a file it chose to
 * have read.
 */
async function pickCaBundle(): Promise<string | null> {
    const owner = BrowserWindow.getFocusedWindow() ?? undefined;
    const options: Electron.OpenDialogOptions = {
        title: 'Choose a CA bundle',
        properties: ['openFile', 'showHiddenFiles'],
        filters: [
            { name: 'Certificates', extensions: ['pem', 'crt', 'cer', 'ca-bundle'] },
            { name: 'All files', extensions: ['*'] },
        ],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const path = result.canceled ? undefined : result.filePaths[0];
    if (!path) return null;
    updateSettings({ network: { caBundlePath: path } });
    reconnect();
    return path;
}

/** The route to the cluster changed, so nothing made over the old one may carry on. */
function reconnect(): void {
    leaveConnection('The proxy settings changed');
    reloadKubeConfig();
}

/** Whether a settings write changed how the app reaches the cluster, which the loaded config holds. */
function networkChanged(before: Settings['network'], after: Settings['network']): boolean {
    return (['proxyMode', 'proxyUrl', 'noProxy', 'caBundlePath'] as const).some((key) => before[key] !== after[key]);
}

/**
 * Everything that must not outlive the connection it was made on: live streams, which the client
 * library would silently re-point at the next cluster, and sampled usage, which belongs to the
 * previous one. Runs before a context switch or a kubeconfig change takes effect.
 */
function leaveConnection(reason: string): void {
    endAllStreams(reason);
    // Every stream is gone, so every informer should be too; this catches any whose last
    // subscriber's teardown has not run yet, since they hold a watch on the cluster being left.
    stopAllInformers();
    resetHistory();
}

const handlers: Handlers = {
    'app.info': async () => ({
        name: app.getName(),
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
    }),
    'update.state': async () => getUpdateState(),
    'update.check': () => checkForUpdates(),
    'update.download': async () => ({ ok: downloadUpdate() }),
    'update.install': async () => ({ ok: installUpdate() }),
    startupChecks: () => runStartupChecks(),
    'contexts.list': async () => listContexts(),
    'context.current': async () => getCurrentContext(),
    'context.set': async ({ name }) => {
        leaveConnection(`The context changed to "${name}"`);
        return setContext(name);
    },
    'namespace.set': async ({ namespace }) => setNamespace(namespace),
    'settings.get': async () => getSettings(),
    'settings.set': async (patch) => {
        const before = getSettings().network;
        const settings = updateSettings(patch);
        setReadTimeoutSec(settings.data.readTimeoutSec);
        applyCheckInterval(settings.updates.checkIntervalHours);
        // The proxy and the CA bundle are read once, when the kubeconfig loads, so a change to either
        // only reaches the cluster after a reload.
        if (networkChanged(before, settings.network)) reconnect();
        return settings;
    },
    'kubeconfig.pick': async () => ({ path: await pickKubeconfig() }),
    'caBundle.pick': async () => ({ path: await pickCaBundle() }),
    'namespaces.list': () => listNamespaces(),
    'namespace.active': () => getActiveNamespaceInfo(),
    'cluster.active': () => getActiveCluster(),
    'clusters.list': () => listClusters(),
    'nodes.list': () => listNodes(),
    'nodes.get': ({ name }) => getNode(name),
    'nodes.cordon': (input) => cordonNode(input),
    'nodes.drainPlan': ({ name, ...options }) => getDrainPlan(name, { ...options }),
    'resources.list': (input) => listResources(input),
    'resources.get': (input) => getResource(input),
    'pods.owners': ({ name, namespace }) => getPodOwners(name, namespace),
    'workloads.pods': ({ kind, name, namespace }) => listOwnedPods(kind, name, namespace),
    'pods.logSnapshot': (input) => readPodLogSnapshot(input),
    'pods.logDownload': (input) => readPodLogText(input),
    'events.forObject': (input) => listEventsForObject(input),
    'events.recent': () => listRecentEvents(),
    'events.list': ({ namespace }) => listEvents(namespace),
    'quotas.list': ({ namespace }) => listQuotas(namespace),
    'limits.list': ({ namespace }) => listLimits(namespace),
    'metrics.sparklines': () => getSparklines(),
    'metrics.workloadHealth': () => getWorkloadHealth(),
    'metrics.alerts': () => listAlerts(),
    'metrics.podSeries': ({ namespace, name }) => getPodSeries(namespace, name),
    'metrics.nodeSeries': ({ name }) => getNodeSeries(name),
    'metrics.deploymentSeries': ({ namespace, name }) => getDeploymentSeries(namespace, name),
    'deployments.replicaSets': ({ name, namespace }) => getDeploymentReplicaSets(name, namespace),
    'deployments.rollouts': ({ name, namespace }) => getDeploymentRollouts(name, namespace),
    'deployments.rolloutStatus': ({ name, namespace }) => getDeploymentRolloutStatus(name, namespace),
    'deployments.rollback': (input) => rollbackDeployment(input),
    'deployments.pause': (input) => setDeploymentPaused(input),
    'deployments.compare': (input) => compareDeploymentRevisions(input),
    'configMaps.entries': ({ name, namespace }) => getConfigMapEntries(name, namespace),
    'secrets.entries': ({ name, namespace }) => getSecretEntries(name, namespace),
    'secrets.reveal': ({ name, namespace, key }) => revealSecretValue(name, namespace, key),
    'services.ports': ({ name, namespace }) => getServicePorts(name, namespace),
    'services.endpoints': ({ name, namespace }) => getServiceEndpoints(name, namespace),
    'ingresses.rules': ({ name, namespace }) => getIngressRules(name, namespace),
    'releases.list': () => listReleases(),
    'releases.get': ({ name, namespace }) => getRelease(name, namespace),
    'releases.revisions': ({ name, namespace }) => getReleaseRevisions(name, namespace),
    'releases.rollback': (input) => rollbackRelease(input),
    'releases.uninstall': (input) => uninstallRelease(input),
    'helmCharts.list': () => listHelmCharts(),
    'namespaces.detail': ({ name }) => getNamespaceDetail(name),
    'customResources.list': ({ crd, namespace }) => listCustomResourceInstances(crd, namespace),
    'customResources.get': ({ crd, name, namespace }) => getCustomResourceInstance(crd, name, namespace),
    'customResources.getYaml': ({ crd, name, namespace }) => getCustomResourceYaml(crd, name, namespace),
    'resources.meta': ({ kind, name, namespace }) => getObjectMeta(kind, name, namespace),
    'resources.related': ({ kind, name, namespace }) => getRelated(kind, name, namespace),
    'resources.getYaml': ({ kind, name, namespace }) => getObjectYaml(kind, name, namespace),
    'resources.describe': (input) => describeObject(input),
    'resources.create': (input) => createResource(input),
    'resources.replace': (input) => replaceResource(input),
    'resources.delete': (input) => deleteResource(input),
    'resources.scale': (input) => scaleResource(input),
    'resources.restart': (input) => restartResource(input),
    'pods.evict': (input) => evictPod(input),
    'jobs.retry': (input) => retryJob(input),
    'cronJobs.trigger': (input) => triggerCronJob(input),
    'cronJobs.suspend': (input) => setCronJobSuspended(input),
    'autoscalers.update': (input) => updateAutoscaler(input),
    'caBundle.clear': async () => {
        const settings = updateSettings({ network: { caBundlePath: null } });
        reconnect();
        return settings;
    },
    'kubeconfig.useDefault': async () => {
        const settings = updateSettings({ connection: { kubeconfigPath: null } });
        leaveConnection('The kubeconfig changed');
        reloadKubeConfig();
        return settings;
    },
};

/**
 * Registers one `ipcMain.handle` per channel in the shared contract. Input is validated before the
 * handler runs and output before it is returned, so a handler bug cannot leak an unexpected shape
 * to the renderer. Results travel in the {@link IpcResult} envelope: a classified `K8sError`
 * becomes `ok: false` with structure, anything else rejects the invoke as the bug it is.
 */
export function registerHandlers(): void {
    for (const channel of Object.keys(ipcSchemas) as IpcChannel[]) {
        ipcMain.handle(channel, async (_event, rawInput: unknown): Promise<IpcResult<unknown>> => {
            const schema = ipcSchemas[channel];
            const input = schema.input.parse(rawInput);
            try {
                const result = await handlers[channel](input as never);
                return { ok: true, data: schema.output.parse(result) };
            } catch (error) {
                if (error instanceof K8sError) return { ok: false, error: error.toIpcError() };
                throw error;
            }
        });
    }
}
