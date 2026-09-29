import {
    FAILSAFE_SCHEMA,
    NOT_RESOLVED,
    Schema,
    defineScalarTag,
    dump as dumpYaml,
    load,
    loadAll,
    mergeTag,
    nullCoreTag,
} from 'js-yaml';

/*
 * Plain js-yaml, never the client library's own dump: that one reserializes through its typed
 * models and silently drops fields it does not know, which for a CRD or a newer API field means the
 * manifest on screen is not the object in the cluster.
 */

/**
 * Serialize a Kubernetes object the way `kubectl get -o yaml` prints it. Server-managed noise is
 * stripped, but `resourceVersion` and `status` stay: the first is what lets a later write be
 * conflict-checked, and the second is what a reader came to look at.
 */
export function yamlToText(obj: object): string {
    return dumpYaml(orderTypeMeta(stripNoise(obj)), { lineWidth: -1, noRefs: true, sortKeys: false });
}

/**
 * Hoist apiVersion and kind to the top. A read omits both, so callers append them as fallbacks and
 * they would otherwise serialize last, where no one expects them.
 */
function orderTypeMeta<T extends object>(obj: T): T {
    const { apiVersion, kind, ...rest } = obj as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    if (apiVersion !== undefined) ordered.apiVersion = apiVersion;
    if (kind !== undefined) ordered.kind = kind;
    return { ...ordered, ...rest } as T;
}

const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

interface CleanableMeta {
    metadata?: { managedFields?: unknown; annotations?: Record<string, string> };
}

function stripNoise<T extends object>(obj: T): T {
    const clone = structuredClone(obj) as T & CleanableMeta;
    if (clone.metadata) {
        delete clone.metadata.managedFields;
        delete clone.metadata.annotations?.[LAST_APPLIED];
        if (clone.metadata.annotations && Object.keys(clone.metadata.annotations).length === 0) {
            delete clone.metadata.annotations;
        }
    }
    return clone;
}

/*
 * Helm and kubectl read a manifest through sigs.k8s.io/yaml, whose go-yaml v2 resolves plain scalars
 * the YAML 1.1 way: `0755` is octal and `yes` is true. Read as YAML 1.2, a chart's
 * `defaultMode: 0644` is 644 decimal, which the API server refuses, and `0400` is a valid mode
 * nobody asked for. These tags follow go-yaml v2's `resolve`, not the YAML 1.1 specification,
 * which also reads `1:20` as a number and `2024-01-01` as a time, where go-yaml hands both on as
 * strings.
 */

const GO_TRUE = ['y', 'Y', 'yes', 'Yes', 'YES', 'true', 'True', 'TRUE', 'on', 'On', 'ON'];
const GO_FALSE = ['n', 'N', 'no', 'No', 'NO', 'false', 'False', 'FALSE', 'off', 'Off', 'OFF'];
const NUMBER_FIRST_CHARS = ['-', '+', '.', ...'0123456789'];

const goBoolTag = defineScalarTag('tag:yaml.org,2002:bool', {
    implicit: true,
    implicitFirstChars: [...new Set([...GO_TRUE, ...GO_FALSE].map((word) => word.charAt(0)))],
    resolve: (source) => {
        if (GO_TRUE.includes(source)) return true;
        if (GO_FALSE.includes(source)) return false;
        return NOT_RESOLVED;
    },
    identify: (data) => typeof data === 'boolean',
});

/** What Go's `strconv.ParseInt(s, 0, 64)` accepts once go-yaml has taken the underscores out. */
const GO_INTEGER = /^([-+]?)(?:0[bB]([01]+)|0[oO]?([0-7]+)|0[xX]([0-9a-fA-F]+)|([1-9][0-9]*|0))$/;

const goIntTag = defineScalarTag('tag:yaml.org,2002:int', {
    implicit: true,
    implicitFirstChars: NUMBER_FIRST_CHARS,
    resolve: (source) => {
        const match = GO_INTEGER.exec(source.replaceAll('_', ''));
        if (!match) return NOT_RESOLVED;
        const [, sign, binary, octal, hex, decimal] = match;
        const value =
            binary !== undefined
                ? Number.parseInt(binary, 2)
                : octal !== undefined
                  ? Number.parseInt(octal, 8)
                  : hex !== undefined
                    ? Number.parseInt(hex, 16)
                    : Number.parseInt(decimal!, 10);
        return sign === '-' ? -value : value;
    },
    identify: (data) => Number.isInteger(data),
});

/** go-yaml's `yamlStyleFloat`, which is also what catches `08`, an octal Go refuses. */
const GO_FLOAT = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;
const GO_SPECIAL_FLOATS: Record<string, number> = {
    '.nan': Number.NaN,
    '.inf': Number.POSITIVE_INFINITY,
    '+.inf': Number.POSITIVE_INFINITY,
    '-.inf': Number.NEGATIVE_INFINITY,
};

const goFloatTag = defineScalarTag('tag:yaml.org,2002:float', {
    implicit: true,
    implicitFirstChars: NUMBER_FIRST_CHARS,
    resolve: (source) => {
        const special = /^([-+]?\.)(nan|NaN|NAN|inf|Inf|INF)$/.exec(source);
        if (special) return GO_SPECIAL_FLOATS[`${special[1]}${special[2]!.toLowerCase()}`] ?? NOT_RESOLVED;
        const plain = source.replaceAll('_', '');
        return GO_FLOAT.test(plain) ? Number.parseFloat(plain) : NOT_RESOLVED;
    },
    identify: (data) => typeof data === 'number',
});

const RENDERED_SCHEMA = new Schema([...FAILSAFE_SCHEMA.tags, nullCoreTag, goBoolTag, goIntTag, goFloatTag, mergeTag]);

/** Read one document Helm rendered or stored, as the Helm CLI reads it. */
export const loadRenderedYaml = (text: string): unknown => load(text, { schema: RENDERED_SCHEMA });

/** Read every document of a rendered or stored manifest, as the Helm CLI reads it. */
export const loadAllRenderedYaml = (text: string): unknown[] => loadAll(text, { schema: RENDERED_SCHEMA });
