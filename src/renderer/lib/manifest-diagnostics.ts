import { useDeferredValue, useMemo } from 'react';
import { diagnose, readManifest, type ManifestDiagnostic } from './manifest-validation';
import { useIpcQuery } from './query';

/** Diagnostics together with the text they were found in, since only that text has their offsets. */
export interface EditorDiagnostics {
    text: string;
    items: ManifestDiagnostic[];
}

/** Asked for when there is nothing to ask about, with the query disabled so it never runs. */
const NO_KIND = { apiVersion: 'v1', kind: 'Pod' } as const;

/**
 * Check the editor's text as it is typed, against the schema the cluster publishes for the kind it
 * names. The check trails typing (a deferred value) so a large object never slows a keystroke, and
 * carries the text it was made on, so the editor never places a mark at an offset of an older one.
 * The schema is read once per kind, from main, which caches it per context; a cluster that publishes
 * none, or cannot be reached, leaves the checks main makes itself.
 */
export function useManifestDiagnostics(text: string, enabled = true): EditorDiagnostics | null {
    const deferred = useDeferredValue(text);
    const read = useMemo(() => (enabled ? readManifest(deferred) : null), [deferred, enabled]);
    const head = read?.head ?? null;
    const schema = useIpcQuery('schemas.forKind', head ?? NO_KIND, {
        enabled: head !== null,
        staleTime: Infinity,
        retry: false,
    });
    return useMemo(
        () => (read ? { text: deferred, items: diagnose(read, head ? schema.data : null) } : null),
        [read, deferred, head, schema.data],
    );
}
