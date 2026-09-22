/**
 * Pure helpers behind a list's selection: the row id every screen keys a checked row by, and the
 * batch of deletes that selection turns into with its summary. Free of React and the DOM, so they
 * are testable on their own.
 */

export interface SelectionTarget {
    name: string;
    namespace?: string;
}

export interface FailedDelete extends SelectionTarget {
    message: string;
}

export interface BulkDeleteResult {
    deleted: SelectionTarget[];
    failed: FailedDelete[];
}

/**
 * A row's selection id. Qualified by namespace so same-named objects in different namespaces stay
 * distinct; neither part can contain a slash, so the join is unambiguous.
 */
export function selectionRowId(target: SelectionTarget): string {
    return `${target.namespace ?? ''}/${target.name}`;
}

/** Run `fn` over the items with at most `limit` in flight, keeping the order of the results. */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]!);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return results;
}

/** The summary of a settled batch: `kind` is the singular, `noun` the plural the page title uses. */
export function bulkDeleteSummary(
    result: BulkDeleteResult,
    kind: string,
    noun: string,
): { ok: boolean; message: string; detail?: string } {
    const deletedLabel = `${result.deleted.length} ${result.deleted.length === 1 ? kind : noun} deleted`;
    if (result.failed.length === 0) return { ok: true, message: deletedLabel };
    const failures = result.failed.map((f) => `${selectionRowId(f).replace(/^\//, '')}: ${f.message}`).join('; ');
    return { ok: false, message: `${deletedLabel}, ${result.failed.length} failed`, detail: failures };
}

/** Selection holding only what failed, so a retry starts from exactly those rows. */
export function failedSelection(failed: readonly SelectionTarget[]): Record<string, boolean> {
    return Object.fromEntries(failed.map((f) => [selectionRowId(f), true]));
}
