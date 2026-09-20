import type { V1ConfigMap, V1Secret } from '@kubernetes/client-node';
import type {
    ConfigMap,
    ConfigMapDetail,
    ConfigMapEntry,
    Secret,
    SecretDetail,
    SecretEntry,
    SecretValue,
} from '../../../shared/k8s/workloads.js';
import { apis, getNamespaced, listItems } from '../client.js';
import { withK8s } from '../errors.js';
import { age, formatBytes, toPairs } from '../format.js';

/*
 * ConfigMaps and Secrets. A Secret is listed and read as key names and a fixed mask; a value crosses
 * the bridge only when the user reveals or copies that one key.
 */

/** Total stored bytes: UTF-8 for text data, decoded length for binary data. */
export function configMapByteSize(configMap: V1ConfigMap): number {
    const data = Object.values(configMap.data ?? {}).reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0);
    const binary = Object.values(configMap.binaryData ?? {}).reduce(
        (sum, value) => sum + Buffer.byteLength(value, 'base64'),
        0,
    );
    return data + binary;
}

export function toConfigMap(configMap: V1ConfigMap, now = Date.now()): ConfigMap {
    return {
        name: configMap.metadata?.name ?? '',
        namespace: configMap.metadata?.namespace ?? '',
        keys: Object.keys(configMap.data ?? {}).length + Object.keys(configMap.binaryData ?? {}).length,
        size: formatBytes(configMapByteSize(configMap)),
        age: age(configMap.metadata?.creationTimestamp, now),
    };
}

export function toConfigMapDetail(configMap: V1ConfigMap, now = Date.now()): ConfigMapDetail {
    return {
        ...toConfigMap(configMap, now),
        labels: toPairs(configMap.metadata?.labels),
        annotations: toPairs(configMap.metadata?.annotations),
    };
}

/** Guessed from the value's own shape, so the entry card can label what it is showing. */
export function contentType(value: string): string {
    const trimmed = value.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'application/json';
    if (trimmed.startsWith('apiVersion:') || trimmed.includes('\n')) return 'text/yaml';
    return 'text/plain';
}

export function toConfigMapEntries(configMap: V1ConfigMap): ConfigMapEntry[] {
    return Object.entries(configMap.data ?? {}).map(([key, value]) => ({
        key,
        contentType: contentType(value),
        size: formatBytes(Buffer.byteLength(value, 'utf8')),
        value,
    }));
}

export function toSecret(secret: V1Secret, now = Date.now()): Secret {
    return {
        name: secret.metadata?.name ?? '',
        namespace: secret.metadata?.namespace ?? '',
        type: secret.type ?? 'Opaque',
        keys: Object.keys(secret.data ?? {}).length + Object.keys(secret.stringData ?? {}).length,
        age: age(secret.metadata?.creationTimestamp, now),
    };
}

export function toSecretDetail(secret: V1Secret, now = Date.now()): SecretDetail {
    return {
        ...toSecret(secret, now),
        labels: toPairs(secret.metadata?.labels),
        annotations: toPairs(secret.metadata?.annotations),
    };
}

/** The mask every secret value is reported as; the real value is never read. */
export const SECRET_MASK = '••••••••';

export function toSecretEntries(secret: V1Secret): SecretEntry[] {
    return Object.keys(secret.data ?? {}).map((key) => ({ key, masked: SECRET_MASK }));
}

export function listConfigMaps(namespace?: string): Promise<ConfigMap[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().core.listNamespacedConfigMap({ namespace: ns }),
            () => apis().core.listConfigMapForAllNamespaces(),
        );
        return items.map((configMap) => toConfigMap(configMap));
    });
}

function readConfigMap(name: string, namespace?: string): Promise<V1ConfigMap | undefined> {
    return getNamespaced(name, namespace, (n, ns) => apis().core.readNamespacedConfigMap({ name: n, namespace: ns }));
}

export function getConfigMap(name: string, namespace?: string): Promise<ConfigMapDetail | null> {
    return withK8s('resources.get', async () => {
        const configMap = await readConfigMap(name, namespace);
        return configMap ? toConfigMapDetail(configMap) : null;
    });
}

export function getConfigMapEntries(name: string, namespace: string): Promise<ConfigMapEntry[]> {
    return withK8s('configMaps.entries', async () => {
        const configMap = await readConfigMap(name, namespace);
        return configMap ? toConfigMapEntries(configMap) : [];
    });
}

export function listSecrets(namespace?: string): Promise<Secret[]> {
    return withK8s('resources.list', async () => {
        const { items } = await listItems(
            namespace,
            (ns) => apis().core.listNamespacedSecret({ namespace: ns }),
            () => apis().core.listSecretForAllNamespaces(),
        );
        return items.map((secret) => toSecret(secret));
    });
}

function readSecret(name: string, namespace?: string): Promise<V1Secret | undefined> {
    return getNamespaced(name, namespace, (n, ns) => apis().core.readNamespacedSecret({ name: n, namespace: ns }));
}

export function getSecret(name: string, namespace?: string): Promise<SecretDetail | null> {
    return withK8s('resources.get', async () => {
        const secret = await readSecret(name, namespace);
        return secret ? toSecretDetail(secret) : null;
    });
}

/** Key names only: the values stay in the cluster, so a compromised renderer cannot read them. */
export function getSecretEntries(name: string, namespace: string): Promise<SecretEntry[]> {
    return withK8s('secrets.entries', async () => {
        const secret = await readSecret(name, namespace);
        return secret ? toSecretEntries(secret) : [];
    });
}

/**
 * A stored value is arbitrary bytes, so only one that survives a UTF-8 round trip can be shown as
 * text; anything else stays base64 and says so, rather than reaching the screen as replacement
 * characters that no longer are the value.
 */
export function decodeSecretValue(key: string, encoded: string): SecretValue {
    const bytes = Buffer.from(encoded, 'base64');
    const text = bytes.toString('utf8');
    const binary = !Buffer.from(text, 'utf8').equals(bytes);
    return { key, value: binary ? bytes.toString('base64') : text, binary };
}

/**
 * One key's value, asked for by name. This is the only read that answers a Secret value, and it
 * answers a single key, so revealing one entry never puts the rest of the map in the renderer.
 */
export function revealSecretValue(name: string, namespace: string, key: string): Promise<SecretValue | null> {
    return withK8s('secrets.reveal', async () => {
        const secret = await readSecret(name, namespace);
        const encoded = secret?.data?.[key];
        return encoded === undefined ? null : decodeSecretValue(key, encoded);
    });
}
