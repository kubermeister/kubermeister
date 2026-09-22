import {
    ApiException,
    ApiextensionsV1Api,
    AppsV1Api,
    AutoscalingV2Api,
    BatchV1Api,
    CoreV1Api,
    CustomObjectsApi,
    KubeConfig,
    KubernetesObjectApi,
    NetworkingV1Api,
    RbacAuthorizationV1Api,
    AdmissionregistrationV1Api,
    ApiregistrationV1Api,
    FlowcontrolApiserverV1Api,
    NodeV1Api,
    StorageV1Api,
    PolicyV1Api,
    SchedulingV1Api,
    CoordinationV1Api,
    VersionApi,
    type Cluster,
    type ConfigOptions,
    type Configuration,
} from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import { abortable, withAbortMiddleware } from './abort.js';
import { K8sError } from './errors.js';
import { guardCredentialPlugins } from './exec-auth.js';
import { applyNetworkSettings } from './proxy.js';
import { isNamespaceName } from '../../shared/k8s/names.js';
import { getSettings } from '../settings/store.js';

/**
 * Owns the mutable connection state: which kube-context is read from and the active namespace.
 * The `KubeConfig` loads lazily from disk and is never written back; the typed API clients are
 * memoised and rebuilt whenever the context changes.
 */

let kc: KubeConfig | null = null;
let apiCache: ApiBundle | null = null;
let activeNamespace: string | null = null;

export interface ApiBundle {
    core: CoreV1Api;
    apps: AppsV1Api;
    batch: BatchV1Api;
    net: NetworkingV1Api;
    rbac: RbacAuthorizationV1Api;
    storage: StorageV1Api;
    /** The `node.k8s.io` group, which holds RuntimeClasses rather than nodes themselves. */
    runtime: NodeV1Api;
    admission: AdmissionregistrationV1Api;
    apiregistration: ApiregistrationV1Api;
    flowcontrol: FlowcontrolApiserverV1Api;
    policy: PolicyV1Api;
    scheduling: SchedulingV1Api;
    coordination: CoordinationV1Api;
    hpa: AutoscalingV2Api;
    version: VersionApi;
    apiextensions: ApiextensionsV1Api;
    customObjects: CustomObjectsApi;
    /** Generic object client for writes: derives the API path from a manifest's own apiVersion/kind. */
    objects: KubernetesObjectApi;
}

/**
 * Apply the remembered session on top of a freshly loaded kubeconfig and return the namespace that
 * should be active. With `restoreOnLaunch` and a remembered context that still exists, the
 * in-memory config is pointed at it (the file is untouched) so the app reopens where the user left
 * off; otherwise the kubeconfig's own current-context wins.
 */
function applyStartupSelection(next: KubeConfig): string | null {
    const { session } = getSettings();
    if (session.restoreOnLaunch && session.lastContext) {
        const remembered = next.getContextObject(session.lastContext);
        if (remembered) {
            next.setCurrentContext(session.lastContext);
            return namespaceOrNull(session.lastNamespace ?? remembered.namespace);
        }
    }
    return namespaceOrNull(next.getContextObject(next.getCurrentContext())?.namespace);
}

/**
 * Only a well-formed namespace name may become the active selection. The settings file and a
 * kubeconfig are both hand-editable; an empty or malformed value would read as "all namespaces"
 * in every fallback and be persisted again on the next switch.
 */
function namespaceOrNull(value: string | null | undefined): string | null {
    return value && isNamespaceName(value) ? value : null;
}

/**
 * A cluster, user or context entry missing what identifies it (an empty `cluster:` left behind by
 * a hand edit or a half-finished `kubectl config set-context`) is dropped rather than failing the
 * whole file. kubectl loads such a file and lists the entry; refusing it would leave every other
 * context unusable over one the user never opens. (The library exports the `ActionOnInvalid`
 * constant as a type only; the value is the literal.)
 */
const LOAD_OPTIONS: Partial<ConfigOptions> = { onInvalidEntry: 'filter' };

/**
 * A kubeconfig that will not load fails every cluster call the same way, as a classified error the
 * renderer can name and act on, rather than as the parser's exception. The parser's message embeds
 * a snippet of the file, so the detail is the sentence {@link kubeconfigError} composes instead.
 */
function loadKubeConfig(): KubeConfig {
    const next = new KubeConfig();
    const { kubeconfigPath } = getSettings().connection;
    try {
        if (kubeconfigPath) next.loadFromFile(kubeconfigPath, LOAD_OPTIONS);
        else next.loadFromDefault(LOAD_OPTIONS);
    } catch {
        throw new K8sError('kubeconfig', kubeconfigError() ?? 'The kubeconfig could not be loaded.', 'kubeconfig');
    }
    guardCredentialPlugins(next);
    // The proxy and any extra certificate authorities are settled here, once, so every client, watch
    // and websocket built from this config already goes the way the user asked.
    applyNetworkSettings(next);
    return next;
}

/** Lazily load the kubeconfig: the settings path when set, else the default ($KUBECONFIG, ~/.kube/config). */
export function kubeConfig(): KubeConfig {
    if (!kc) {
        const next = loadKubeConfig();
        activeNamespace = applyStartupSelection(next);
        kc = next;
    }
    return kc;
}

/**
 * Validate the kubeconfig the app will load, without touching the memoised state. Returns a
 * human-readable reason or null. A missing default kubeconfig is not an error (the app opens
 * offline); an unparseable one is. Messages deliberately omit the parser's own text, which embeds
 * a snippet of the file and would leak its contents to the renderer.
 */
export function kubeconfigError(): string | null {
    const { kubeconfigPath } = getSettings().connection;
    if (kubeconfigPath) {
        if (!existsSync(kubeconfigPath)) return `No file exists at ${kubeconfigPath}.`;
        try {
            new KubeConfig().loadFromFile(kubeconfigPath, LOAD_OPTIONS);
            return null;
        } catch {
            return `${kubeconfigPath} could not be parsed as a kubeconfig file.`;
        }
    }
    try {
        new KubeConfig().loadFromDefault(LOAD_OPTIONS);
        return null;
    } catch {
        return 'The default kubeconfig ($KUBECONFIG or ~/.kube/config) could not be parsed.';
    }
}

/**
 * Why a context cannot be used, or null. The kubeconfig loads with entries kubectl tolerates dropped,
 * so a context can survive while the cluster or user it names did not (a hand edit, a cluster removed
 * with `kubectl config delete-cluster` while its context stayed). The library lists such a context
 * and switches to it, then fails every call with "No active cluster!" or an unauthenticated request;
 * naming the missing entry here is what lets the screen say so and point at the context selector.
 */
export function contextProblem(kc: KubeConfig, name: string): string | null {
    const ctx = kc.getContextObject(name);
    if (!ctx) return `Context "${name}" is not in the kubeconfig.`;
    if (!kc.getCluster(ctx.cluster)) {
        return `Context "${name}" names cluster "${ctx.cluster}", which the kubeconfig does not define or which has no server.`;
    }
    if (!kc.getUser(ctx.user))
        return `Context "${name}" names user "${ctx.user}", which the kubeconfig does not define.`;
    return null;
}

/** The current context's problem, or null when there is none or no context is current at all. */
export function currentContextProblem(): string | null {
    const kc = kubeConfig();
    const current = kc.getCurrentContext();
    return current ? contextProblem(kc, current) : null;
}

/**
 * The generic object client, abortable like the rest. Its own `makeApiClient` names the base class,
 * so the subclass builds itself and repeats the one thing that static does beyond `new`: seed the
 * default namespace from the current context.
 */
class AbortableObjectApi extends KubernetesObjectApi {
    constructor(configuration: Configuration) {
        super(withAbortMiddleware(configuration));
    }

    static forConfig(kc: KubeConfig): KubernetesObjectApi {
        const client = kc.makeApiClient(AbortableObjectApi);
        client.setDefaultNamespace(kc);
        return client;
    }
}

export function apis(): ApiBundle {
    if (!apiCache) {
        const c = kubeConfig();
        // Fail closed with a sentence rather than let the library throw on the cluster and send an
        // unauthenticated request for a missing user.
        const problem = currentContextProblem();
        if (problem) throw new K8sError('kubeconfig', problem, 'kubeconfig');
        apiCache = {
            core: c.makeApiClient(abortable(CoreV1Api)),
            apps: c.makeApiClient(abortable(AppsV1Api)),
            batch: c.makeApiClient(abortable(BatchV1Api)),
            net: c.makeApiClient(abortable(NetworkingV1Api)),
            rbac: c.makeApiClient(abortable(RbacAuthorizationV1Api)),
            storage: c.makeApiClient(abortable(StorageV1Api)),
            runtime: c.makeApiClient(abortable(NodeV1Api)),
            admission: c.makeApiClient(abortable(AdmissionregistrationV1Api)),
            apiregistration: c.makeApiClient(abortable(ApiregistrationV1Api)),
            flowcontrol: c.makeApiClient(abortable(FlowcontrolApiserverV1Api)),
            policy: c.makeApiClient(abortable(PolicyV1Api)),
            scheduling: c.makeApiClient(abortable(SchedulingV1Api)),
            coordination: c.makeApiClient(abortable(CoordinationV1Api)),
            hpa: c.makeApiClient(abortable(AutoscalingV2Api)),
            version: c.makeApiClient(abortable(VersionApi)),
            apiextensions: c.makeApiClient(abortable(ApiextensionsV1Api)),
            customObjects: c.makeApiClient(abortable(CustomObjectsApi)),
            objects: AbortableObjectApi.forConfig(c),
        };
    }
    return apiCache;
}

/** Drop the memoised API clients so the next `apis()` call rebuilds them against the current context. */
export function invalidateApis(): void {
    apiCache = null;
}

/** Forget the loaded kubeconfig so the next access re-reads it from disk. */
export function reloadKubeConfig(): void {
    kc = null;
    apiCache = null;
    activeNamespace = null;
}

export function getActiveNamespace(): string | null {
    kubeConfig(); // seeds activeNamespace from the context's default on first access
    return activeNamespace;
}

export function setActiveNamespace(namespace: string | null): void {
    kubeConfig(); // load first, or the lazy load would overwrite this selection with the context default
    activeNamespace = namespaceOrNull(namespace);
}

/** Namespace a list call targets: explicit argument, else the active selection, else all (undefined). */
export function resolveNamespace(explicit?: string): string | undefined {
    return explicit ?? getActiveNamespace() ?? undefined;
}

/**
 * Run a namespaced-or-all list read. `allNamespaces` forces the cluster-wide path regardless of the
 * active namespace, for reads whose meaning is cluster-scoped.
 */
export async function listItems<T>(
    namespace: string | undefined,
    namespacedFn: (namespace: string) => Promise<{ items: T[] }>,
    allFn: () => Promise<{ items: T[] }>,
    allNamespaces = false,
): Promise<{ items: T[] }> {
    if (allNamespaces) return allFn();
    const ns = resolveNamespace(namespace);
    return ns ? namespacedFn(ns) : allFn();
}

/**
 * Namespace a single-object read targets: explicit, else the active selection, else null, which
 * every reader treats as "not found" rather than searching the cluster for a same-named object.
 */
export function resolveObjectNamespace(explicit?: string): string | null {
    return explicit ?? getActiveNamespace();
}

/**
 * DNS-1123 and Kind characters only. Such a value cannot contain the `,` or `=` separators of a
 * fieldSelector, so it is safe to interpolate into `metadata.name=<value>`. Anything else is a
 * malformed or injected identifier and is rejected rather than allowed to smuggle selector terms.
 */
const FIELD_SELECTOR_SAFE = /^[A-Za-z0-9.-]+$/;

export function isSafeSelectorValue(value: string): boolean {
    return FIELD_SELECTOR_SAFE.test(value);
}

/**
 * Label keys may carry a DNS prefix (`app.kubernetes.io/name`), values may be empty; neither may
 * hold the `,`, `=` or `!` a labelSelector uses as syntax.
 */
const LABEL_KEY_SAFE = /^[A-Za-z0-9._/-]+$/;
const LABEL_VALUE_SAFE = /^[A-Za-z0-9._-]*$/;

export function isSafeLabelKey(key: string): boolean {
    return LABEL_KEY_SAFE.test(key);
}

export function isSafeLabelValue(value: string): boolean {
    return LABEL_VALUE_SAFE.test(value);
}

/** Run a single-object GET, mapping a 404 to `undefined` so a deleted object reads as "not found". */
export async function readOrNull<T>(read: () => Promise<T>): Promise<T | undefined> {
    try {
        return await read();
    } catch (error) {
        if (error instanceof ApiException && error.code === 404) return undefined;
        throw error;
    }
}

/**
 * Resolve one namespaced object by name with a direct GET in the explicit or active namespace.
 * With neither the read fails closed and answers "not found": guessing which same-named object
 * across the cluster was meant would hand the editor, and so a later replace, the wrong object.
 */
export async function getNamespaced<T>(
    name: string,
    namespace: string | undefined,
    readOne: (name: string, namespace: string) => Promise<T>,
): Promise<T | undefined> {
    const ns = resolveObjectNamespace(namespace);
    if (!ns) return undefined;
    return readOrNull(() => readOne(name, ns));
}

/** The cluster entry the current context names, as the app will connect to it, or null. */
export function currentCluster(): Cluster | null {
    return kubeConfig().getCurrentCluster();
}

/** The kube-context every call currently goes to; the stamp a write must match. */
export function activeContextName(): string {
    return kubeConfig().getCurrentContext();
}
