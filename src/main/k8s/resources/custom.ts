import type { KubernetesObject, V1CustomResourceDefinition } from '@kubernetes/client-node';
import type {
    CustomColumn,
    CustomResourceDetail,
    CustomResourceGetOutput,
    CustomResourceListOutput,
    CustomResourceRow,
} from '../../../shared/k8s/custom.js';
import type { Manifest } from '../../../shared/k8s/manifest.js';
import { apis, readOrNull, resolveObjectNamespace } from '../client.js';
import { K8sError, withK8s } from '../errors.js';
import { yamlToText } from '../yaml.js';
import { age, toPairs } from '../format.js';

/*
 * Instances of a custom resource definition. The app knows nothing about these kinds in advance,
 * so everything a row shows comes from the definition itself: its served version, whether its
 * instances live in namespaces, and the printer columns `kubectl get` would print.
 */

/**
 * The version a client should read: the storage one when it is served, else the first served one.
 * Mid-migration the storage version can be unserved, and every read of it answers 404.
 */
export function readableVersion(crd: V1CustomResourceDefinition): string | undefined {
    const served = (crd.spec?.versions ?? []).filter((version) => version.served);
    return (served.find((version) => version.storage) ?? served[0])?.name;
}

/** The printer columns of that version, which is what the definition says a list should show. */
export function printerColumns(crd: V1CustomResourceDefinition, version: string | undefined): CustomColumn[] {
    const declared = crd.spec?.versions?.find((one) => one.name === version)?.additionalPrinterColumns ?? [];
    return (
        declared
            // Age is the app's own last column on every list; a duplicate would just repeat it.
            .filter((column) => column.jsonPath !== '.metadata.creationTimestamp')
            .map((column) => ({ name: column.name, jsonPath: column.jsonPath, type: column.type }))
    );
}

/**
 * The subset of JSONPath that printer columns actually use: dot-separated keys, with `['quoted']`
 * or `[0]` steps. The quoted form is what carries keys containing dots, such as a label name, so it
 * is tokenised rather than rewritten into dots. Anything richer (filters, wildcards, unions) is
 * refused outright: half-evaluating one would produce a value that looks right and is not.
 */
export function pathSteps(jsonPath: string): string[] | null {
    const source = jsonPath.startsWith('$') ? jsonPath.slice(1) : jsonPath;
    const steps: string[] = [];
    let index = 0;
    while (index < source.length) {
        const char = source[index];
        if (char === '.') {
            index += 1;
            continue;
        }
        if (char === '[') {
            const quote = source[index + 1];
            if (quote === "'" || quote === '"') {
                const end = source.indexOf(`${quote}]`, index + 2);
                if (end === -1) return null;
                steps.push(source.slice(index + 2, end));
                index = end + 2;
                continue;
            }
            const end = source.indexOf(']', index);
            const digits = end === -1 ? '' : source.slice(index + 1, end);
            if (!/^\d+$/.test(digits)) return null;
            steps.push(digits);
            index = end + 1;
            continue;
        }
        const next = source.slice(index).search(/[.[]/);
        const key = next === -1 ? source.slice(index) : source.slice(index, index + next);
        if (/[*?,:]/.test(key)) return null;
        if (key.length > 0) steps.push(key);
        index = next === -1 ? source.length : index + next;
    }
    return steps;
}

export function valueAt(object: unknown, jsonPath: string): unknown {
    const steps = pathSteps(jsonPath);
    if (!steps) return undefined;

    let current: unknown = object;
    for (const step of steps) {
        if (current === null || current === undefined) return undefined;
        if (Array.isArray(current)) {
            const index = Number(step);
            current = Number.isInteger(index) ? current[index] : undefined;
            continue;
        }
        if (typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[step];
    }
    return current;
}

/** One cell, rendered the way kubectl renders it: dates as ages, objects as JSON, nothing as a dash. */
export function renderCell(value: unknown, type: string, now = Date.now()): string {
    if (value === null || value === undefined) return '—';
    if (type === 'date') return age(String(value), now);
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

export function toCustomResourceRow(
    object: KubernetesObject,
    columns: CustomColumn[],
    now = Date.now(),
): CustomResourceRow {
    const cells: Record<string, string> = {};
    for (const column of columns)
        cells[column.jsonPath] = renderCell(valueAt(object, column.jsonPath), column.type, now);
    return {
        name: object.metadata?.name ?? '',
        namespace: object.metadata?.namespace ?? '',
        age: age(object.metadata?.creationTimestamp, now),
        cells,
    };
}

export function toCustomResourceDetail(
    object: KubernetesObject,
    columns: CustomColumn[],
    now = Date.now(),
): CustomResourceDetail {
    return {
        ...toCustomResourceRow(object, columns, now),
        labels: toPairs(object.metadata?.labels),
        annotations: toPairs(object.metadata?.annotations),
    };
}

/** What a definition says about its own instances: where they live and how they read. */
interface Shape {
    group: string;
    version: string;
    plural: string;
    kind: string;
    namespaced: boolean;
    columns: CustomColumn[];
}

async function shapeOf(crd: string, op: string): Promise<Shape> {
    const definition = await readOrNull(() => apis().apiextensions.readCustomResourceDefinition({ name: crd }));
    if (!definition) throw new K8sError('notFound', `No definition named "${crd}" is installed.`, op);
    const version = readableVersion(definition);
    if (!version) throw new K8sError('invalid', `"${crd}" serves no version this app can read.`, op);
    return {
        group: definition.spec?.group ?? '',
        version,
        plural: definition.spec?.names?.plural ?? '',
        kind: definition.spec?.names?.kind ?? '',
        namespaced: definition.spec?.scope === 'Namespaced',
        columns: printerColumns(definition, version),
    };
}

/** A custom object list, whichever scope the definition declares. */
export function listCustomResourceInstances(crd: string, namespace?: string): Promise<CustomResourceListOutput> {
    const op = 'customResources.list';
    return withK8s(op, async () => {
        const shape = await shapeOf(crd, op);
        const scoped = shape.namespaced ? (resolveObjectNamespace(namespace) ?? undefined) : undefined;
        const response = shape.namespaced
            ? scoped
                ? await apis().customObjects.listNamespacedCustomObject({
                      group: shape.group,
                      version: shape.version,
                      plural: shape.plural,
                      namespace: scoped,
                  })
                : // This one call names the plural differently from every other custom-object call.
                  await apis().customObjects.listCustomObjectForAllNamespaces({
                      group: shape.group,
                      version: shape.version,
                      resourcePlural: shape.plural,
                  })
            : await apis().customObjects.listClusterCustomObject({
                  group: shape.group,
                  version: shape.version,
                  plural: shape.plural,
              });
        const items = ((response as { items?: KubernetesObject[] }).items ?? []).map((object) =>
            toCustomResourceRow(object, shape.columns),
        );
        return { kind: shape.kind, namespaced: shape.namespaced, columns: shape.columns, items };
    });
}

/** One instance. A namespaced kind with no namespace known reads as not found, never first-match. */
export function getCustomResourceInstance(
    crd: string,
    name: string,
    namespace?: string,
): Promise<CustomResourceGetOutput> {
    const op = 'customResources.get';
    return withK8s(op, async () => {
        const shape = await shapeOf(crd, op);
        const head = { kind: shape.kind, namespaced: shape.namespaced, columns: shape.columns };
        if (shape.namespaced) {
            const scoped = resolveObjectNamespace(namespace) ?? undefined;
            if (!scoped) return { ...head, item: null };
            const object = await readOrNull(() =>
                apis().customObjects.getNamespacedCustomObject({
                    group: shape.group,
                    version: shape.version,
                    plural: shape.plural,
                    namespace: scoped,
                    name,
                }),
            );
            return { ...head, item: object ? toCustomResourceDetail(object as KubernetesObject, shape.columns) : null };
        }
        const object = await readOrNull(() =>
            apis().customObjects.getClusterCustomObject({
                group: shape.group,
                version: shape.version,
                plural: shape.plural,
                name,
            }),
        );
        return { ...head, item: object ? toCustomResourceDetail(object as KubernetesObject, shape.columns) : null };
    });
}

/**
 * One instance as the cluster holds it. The editor writes it back through the same
 * `resources.replace` every other kind uses: that call derives the API path from the manifest's own
 * `apiVersion` and `kind`, so a custom resource needs no write path of its own.
 */
export function getCustomResourceYaml(crd: string, name: string, namespace?: string): Promise<Manifest> {
    const op = 'customResources.getYaml';
    return withK8s(op, async () => {
        const shape = await shapeOf(crd, op);
        const scoped = shape.namespaced ? (resolveObjectNamespace(namespace) ?? undefined) : undefined;
        if (shape.namespaced && !scoped) {
            throw new K8sError('invalid', `A namespace is required to read ${shape.kind} "${name}".`, op);
        }
        const object = scoped
            ? await readOrNull(() =>
                  apis().customObjects.getNamespacedCustomObject({
                      group: shape.group,
                      version: shape.version,
                      plural: shape.plural,
                      namespace: scoped,
                      name,
                  }),
              )
            : await readOrNull(() =>
                  apis().customObjects.getClusterCustomObject({
                      group: shape.group,
                      version: shape.version,
                      plural: shape.plural,
                      name,
                  }),
              );
        if (!object) throw new K8sError('notFound', `${shape.kind} "${name}" was not found.`, op);
        const manifest = object as Record<string, unknown> & { metadata?: { namespace?: string } };
        manifest.apiVersion ??= shape.group ? `${shape.group}/${shape.version}` : shape.version;
        manifest.kind ??= shape.kind;
        return {
            yaml: yamlToText(manifest),
            apiVersion: String(manifest.apiVersion),
            kind: shape.kind,
            namespace: manifest.metadata?.namespace,
        };
    });
}
