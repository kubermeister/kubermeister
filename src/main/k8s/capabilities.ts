import type { ChartCapabilities } from '../charts/render.js';
import { apis } from './client.js';
import { clusterGet } from './cluster-get.js';
import { withK8s } from './errors.js';

/**
 * What a chart's `.Capabilities` must answer for, read from the cluster the chart is being rendered
 * for: the Helm child that renders it has no cluster to ask. The version is the API server's own
 * `gitVersion`, so `semverCompare` sees the build a chart may test for, and the API versions are the
 * list Helm's own discovery builds — every group-version plus every `group-version/Kind` — so
 * `.Capabilities.APIVersions.Has` answers the same whichever form a chart asks in.
 */

const OP = 'charts.capabilities';

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function coreVersions(body: unknown): string[] {
    return asArray((body as { versions?: unknown } | null)?.versions).filter(
        (one): one is string => typeof one === 'string',
    );
}

function groupVersions(body: unknown): string[] {
    return asArray((body as { groups?: unknown } | null)?.groups).flatMap((group) =>
        asArray((group as { versions?: unknown } | null)?.versions)
            .map((version) => (version as { groupVersion?: unknown } | null)?.groupVersion)
            .filter((one): one is string => typeof one === 'string'),
    );
}

/**
 * The version set from the group-versions and their resource lists, in the same order. A resource
 * list that could not be read still leaves its group-version in, as Helm keeps a group whose
 * discovery failed; subresources (`pods/log`) name no kind of their own and are left out.
 */
export function apiVersionSet(versions: string[], resourceLists: unknown[]): string[] {
    const set = new Set<string>();
    versions.forEach((groupVersion, index) => {
        set.add(groupVersion);
        for (const resource of asArray((resourceLists[index] as { resources?: unknown } | null)?.resources)) {
            const { name, kind } = (resource ?? {}) as { name?: unknown; kind?: unknown };
            if (typeof name !== 'string' || typeof kind !== 'string' || name.includes('/')) continue;
            set.add(`${groupVersion}/${kind}`);
        }
    });
    return [...set].sort();
}

/**
 * The live cluster's capabilities. A group-version whose resources cannot be listed — an
 * aggregated API whose backend is down is the usual one — costs only its kinds, since a whole
 * render refused over metrics-server would be the wrong answer to a chart that never asks for it.
 */
export function clusterCapabilities(): Promise<ChartCapabilities> {
    return withK8s(OP, async () => {
        const [version, core, groups] = await Promise.all([
            apis().version.getCode(),
            clusterGet('/api', OP),
            clusterGet('/apis', OP),
        ]);
        const versions = [...coreVersions(core), ...groupVersions(groups)];
        const resourceLists = await Promise.all(
            versions.map((groupVersion) =>
                clusterGet(groupVersion.includes('/') ? `/apis/${groupVersion}` : `/api/${groupVersion}`, OP).catch(
                    () => null,
                ),
            ),
        );
        return { kubeVersion: version.gitVersion, apiVersions: apiVersionSet(versions, resourceLists) };
    });
}
