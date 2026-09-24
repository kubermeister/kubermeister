import type { ManifestKind } from '../../../shared/k8s/manifest';
import { SelectionBar } from '@/components/templates/selection-bar';
import { ReadErrorHints } from '@/components/templates/read-error-hints';
import { selectionRowId } from '@/lib/selection';
import { useScope } from '@/lib/scope';
import { useDeferredValue, useMemo, useState } from 'react';
import {
    getCoreRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    useReactTable,
    type ColumnDef,
    type OnChangeFn,
    type RowSelectionState,
    type SortingState,
} from '@tanstack/react-table';
import type { UseQueryResult } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { EyeIcon, SearchIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DataTable } from '@/components/data-display/data-table';
import { RefreshButton } from '@/components/refresh-button';
import { useNavigateTo } from '@/components/layout/nav-link';
import { ageToSeconds, namespaceColumn, selectColumn } from '@/components/templates/list-columns';
import { describeError, readErrorSentence } from '@/lib/k8s-error';
import { usePersistedColumns } from '@/lib/persisted-columns';
import { SCREEN_SEARCH } from '@/lib/shortcuts';

/** The slice of a TanStack Query result the list page consumes: data, load/error flags, error, and retry. */
type ListQuery<T> = Pick<UseQueryResult<T[]>, 'data' | 'isPending' | 'isError' | 'error' | 'refetch'>;

interface ResourceListPageProps<T> {
    icon: LucideIcon;
    title: string;
    columns: ColumnDef<T>[];
    /** The list query — derives data / count / loading / error / retry centrally. */
    query: ListQuery<T>;
    /** Row → detail path; wired to row-click navigation via `useNavigateTo`. */
    detailPath?: (row: T) => string;
    /**
     * Plural noun for generated copy, spelled as the screen's title is ("Stateful Sets"). Defaults
     * to `title`, so screens whose title already is the plural kind need not pass it; override when
     * the title differs from the noun (e.g. title "Persistent Volume Claims", noun "PVCs").
     */
    nounPlural?: string;
    searchPlaceholder?: string;
    emptyMessage?: string;
    footerNote?: string;
    toolbar?: React.ReactNode;
    /** Extra attributes per row (`data-*` hooks for tests and styling). */
    rowProps?: (row: T) => Record<string, string>;
    /** Group rows under headings by this key; the screen owns the control that picks it. */
    groupBy?: (row: T) => string;
    /**
     * Turn on row selection and the bar that acts on it — export and bulk delete — for this kind.
     * The plural noun for the copy is the page's own `nounPlural` or title.
     */
    selection?: { kind: ManifestKind };
    /**
     * The kind ignores the active namespace (nodes, storage classes, cluster roles, ...). The page
     * uses it to hold back advice that only applies to a namespaced list, such as narrowing the
     * scope after a timeout.
     */
    clusterScoped?: boolean;
    /** `data-testid` for the rendered table. */
    testId?: string;
}

/**
 * Rows per page. The table renders only what is on screen, so a page is about how much a screen
 * holds in memory rather than how much it can draw; paging is the fallback for a list so large that
 * even sorting it client-side would hurt.
 */
const PAGE_SIZE = 500;

/** One shared empty selection, so an unselected scope does not re-render the table each time. */
const EMPTY_SELECTION: RowSelectionState = {};
const SORTABLE_TYPES = ['string', 'number', 'boolean'];

/**
 * Union of field ids holding a sortable (primitive, non-null) value across a few sample rows.
 * Scanning more than the first row matters because a field can be null on the first row but present
 * on later ones (e.g. an optional `node` on a pending pod) — sampling only `rows[0]` would wrongly disable
 * sorting for that whole column.
 */
const SORT_SAMPLE_ROWS = 8;

/**
 * The single seam for the list page's **id-keyed** row access. This component is generic over the row
 * type `T`, so sorting, search, and the namespace auto-inject reach fields by a column *id* (a string)
 * rather than a typed key — there is no `T`-field knowledge at this layer. Rename-safety lives
 * upstream: the `list-columns` factories tie each column id to a real model field (`ScalarKey<T>` /
 * typed `T` constraints) and every cell renderer reads `row.original.<field>` typed, so a renamed
 * field breaks the column definition (a compile error) — not this deliberately-generic read.
 */
function fieldByColumnId(row: unknown, id: string): unknown {
    return (row as Record<string, unknown>)[id];
}

function sortableFieldIds(samples: unknown[]): Set<string> {
    const ids = new Set<string>();
    for (const sample of samples.slice(0, SORT_SAMPLE_ROWS)) {
        if (sample && typeof sample === 'object') {
            for (const [key, value] of Object.entries(sample)) {
                if (value !== null && SORTABLE_TYPES.includes(typeof value)) ids.add(key);
            }
        }
    }
    return ids;
}

/**
 * List columns are defined with an `id` + `cell` renderer but no accessor, so the table has no value
 * to sort by. Inject an `accessorFn` reading `row[id]` for columns whose id is a sortable field
 * (`sortableIds`) — leaving id-less / non-primitive columns (e.g. `actions`) as unsortable display
 * columns. Keyed on the field-id *set*, not row identity, so it's stable across polls and watch events.
 */
function withSortAccessors<T>(columns: ColumnDef<T>[], sortableIds: Set<string>): ColumnDef<T>[] {
    if (sortableIds.size === 0) return columns;
    return columns.map((column) => {
        const id = column.id;
        const hasAccessor = 'accessorKey' in column || 'accessorFn' in column;
        if (hasAccessor || column.enableSorting === false || typeof id !== 'string' || !sortableIds.has(id)) {
            return column;
        }
        const accessorFn =
            id === 'age'
                ? (item: T) => ageToSeconds(String(fieldByColumnId(item, id)))
                : (item: T) => fieldByColumnId(item, id);
        return { ...column, accessorFn } as ColumnDef<T>;
    });
}

/** Case-insensitive match against a row's values for the given (visible) field ids. */
function rowMatchesQuery<T>(item: T, query: string, fieldIds: string[]): boolean {
    return fieldIds.some((id) => {
        const value = fieldByColumnId(item, id);
        const type = typeof value;
        return (
            (type === 'string' || type === 'number' || type === 'boolean') &&
            String(value).toLowerCase().includes(query)
        );
    });
}

export function ResourceListPage<T>({
    icon: Icon,
    title,
    columns,
    query,
    detailPath,
    nounPlural,
    selection,
    searchPlaceholder,
    emptyMessage,
    footerNote,
    toolbar,
    rowProps,
    groupBy,
    clusterScoped = false,
    testId,
}: ResourceListPageProps<T>) {
    const navigateTo = useNavigateTo();

    // Memoized so the `[]` fallback doesn't churn identity and destabilize the downstream memos.
    const rows = useMemo(() => query.data ?? [], [query.data]);
    const loading = query.isPending;
    const errored = query.isError;
    const resolvedCount = query.data?.length;
    const retry = query.refetch;
    const parsedError = query.error ? describeError(query.error) : null;

    // Generated copy keeps kind casing via `nounPlural ?? title` (never lowercased kind names).
    const noun = nounPlural ?? title;
    const placeholder = searchPlaceholder ?? `Search ${noun}…`;
    const emptyCopy = emptyMessage ?? `No ${noun} found.`;

    const [search, setSearch] = useState('');
    // Defer the value that drives the O(n×fields) filter so typing stays responsive on large lists —
    // the input updates immediately, React reconciles the filtered rows at a lower priority.
    const queryText = useDeferredValue(search).trim().toLowerCase();
    const [sorting, setSorting] = useState<SortingState>([]);
    // Which columns this screen shows is a preference about one window, like the theme, so it is
    // remembered per screen rather than synced: the test id already names the screen uniquely.
    const [columnVisibility, setColumnVisibility] = usePersistedColumns(testId ?? title);

    // Selection is kept per scope: after a context or namespace switch the page reads a different,
    // empty bucket, so a stale selection can never delete same-named objects in the new scope.
    const { context, namespace, allNamespaces } = useScope();
    const scopeId = `${context ?? ''}/${namespace ?? '*'}`;
    const [selectionByScope, setSelectionByScope] = useState<Record<string, RowSelectionState>>({});
    const rowSelection = selectionByScope[scopeId] ?? EMPTY_SELECTION;
    const onRowSelectionChange: OnChangeFn<RowSelectionState> = (updater) =>
        setSelectionByScope((previous) => {
            const current = previous[scopeId] ?? EMPTY_SELECTION;
            return { ...previous, [scopeId]: typeof updater === 'function' ? updater(current) : updater };
        });

    // Under "All namespaces" (rows spanning ≥2 namespaces), inject a Namespace column after Name so
    // same-named objects in different namespaces are distinguishable — unless the screen already
    // defines its own namespace column.
    const effectiveColumns = useMemo(() => {
        if (columns.some((column) => column.id === 'namespace')) return columns;
        const namespaces = new Set<string>();
        for (const row of rows) {
            const ns = fieldByColumnId(row, 'namespace');
            if (typeof ns === 'string' && ns) namespaces.add(ns);
        }
        if (namespaces.size < 2) return columns;
        const nsColumn = namespaceColumn<T & { namespace?: string }>() as ColumnDef<T>;
        const nameIndex = columns.findIndex((column) => column.id === 'name');
        if (nameIndex === -1) return [nsColumn, ...columns];
        return [...columns.slice(0, nameIndex + 1), nsColumn, ...columns.slice(nameIndex + 1)];
    }, [columns, rows]);

    // Search matches only currently-visible columns' underlying fields.
    const visibleFieldIds = useMemo(
        () =>
            effectiveColumns
                .map((column) => column.id)
                // TanStack treats an absent key as visible, so only an explicit `false` hides a column.
                .filter((id): id is string => typeof id === 'string' && columnVisibility[id] !== false),
        [effectiveColumns, columnVisibility],
    );
    const filteredData = useMemo(
        () => (queryText ? rows.filter((item) => rowMatchesQuery(item, queryText, visibleFieldIds)) : rows),
        [rows, queryText, visibleFieldIds],
    );
    // The checkbox column leads the row, added after the namespace injection so that memo's
    // name-index maths is untouched.
    const selectable = !!selection;
    const displayColumns = useMemo(
        () => (selectable ? [selectColumn<T>(), ...effectiveColumns] : effectiveColumns),
        [selectable, effectiveColumns],
    );

    // The sortable-field signature of the sampled rows is stable across polls (only the *shape*
    // matters, not the values), so key the column-model memo on it — not on the row array's per-poll
    // identity — to stop TanStack Table rebuilding every column model on every poll or watch event.
    const sampleSignature = [...sortableFieldIds(rows)].sort().join(',');
    const sortableColumns = useMemo(
        () => withSortAccessors(displayColumns, sampleSignature ? new Set(sampleSignature.split(',')) : new Set()),
        [displayColumns, sampleSignature],
    );

    // TanStack Table returns non-memoizable functions; React Compiler intentionally
    // skips this hook. Safe here — we don't pass table internals into memoized children.
    // eslint-disable-next-line react-hooks/incompatible-library
    const table = useReactTable({
        data: filteredData,
        columns: sortableColumns,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        onSortingChange: setSorting,
        onColumnVisibilityChange: setColumnVisibility,
        // A namespace-qualified row id keeps a selection stable across polls and unambiguous when
        // rows from several namespaces share a name.
        getRowId: selectable ? (row) => selectionRowId(row as T & { name: string; namespace?: string }) : undefined,
        enableRowSelection: selectable,
        onRowSelectionChange,
        initialState: { pagination: { pageSize: PAGE_SIZE } },
        state: { sorting, columnVisibility, rowSelection },
    });
    const hideableColumns = table.getAllColumns().filter((column) => column.getCanHide());
    const pageCount = table.getPageCount();
    const pageIndex = table.getState().pagination.pageIndex;

    const activeSort = sorting[0];
    const sortColumn = activeSort ? table.getColumn(activeSort.id) : undefined;
    const sortLabel = typeof sortColumn?.columnDef.header === 'string' ? sortColumn.columnDef.header : activeSort?.id;
    const footer = [activeSort ? `sorted by ${sortLabel} ${activeSort.desc ? 'desc' : 'asc'}` : null, footerNote]
        .filter(Boolean)
        .join(' · ');
    const resultCount = filteredData.length;

    const rowClick = detailPath ? (row: T) => navigateTo(detailPath(row)) : undefined;

    return (
        <div className="flex h-full flex-col bg-background" data-testid="resource-list">
            <div className="flex items-center gap-2.5 px-4.5 pt-3.5">
                <Icon className="size-4 text-primary" />
                <h1 className="text-base font-semibold">{title}</h1>
                {resolvedCount != null && (
                    <Badge variant="neutral" className="rounded-sm">
                        {resolvedCount}
                    </Badge>
                )}
                <div className="flex-1" />
                {selection && <SelectionBar table={table} kind={selection.kind} noun={noun} />}
                <div className="relative w-60">
                    <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-dim" />
                    <Input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder={placeholder}
                        aria-label={placeholder}
                        {...SCREEN_SEARCH}
                        className="h-8 pl-8 text-body"
                    />
                </div>
                {toolbar}
                <RefreshButton />
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm">
                            <EyeIcon />
                            Columns
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                        {hideableColumns.map((column) => (
                            <DropdownMenuCheckboxItem
                                key={column.id}
                                checked={column.getIsVisible()}
                                onCheckedChange={(value) => column.toggleVisibility(value)}
                                onSelect={(event) => event.preventDefault()}
                            >
                                {typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id}
                            </DropdownMenuCheckboxItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            <div className="flex min-h-0 flex-1 flex-col p-4.5 pt-3">
                <Card className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-card py-0 shadow-none">
                    {loading ? (
                        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3.5">
                            {Array.from({ length: 8 }).map((_, i) => (
                                <Skeleton key={i} className="h-9 w-full" />
                            ))}
                        </div>
                    ) : errored ? (
                        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-body text-text-muted">
                            <div className="flex flex-col items-center gap-1">
                                {parsedError && (
                                    <span className="font-medium text-foreground">{parsedError.title}</span>
                                )}
                                <span>
                                    {parsedError
                                        ? readErrorSentence(parsedError.kind, { plural: noun })
                                        : `Failed to load ${noun}.`}
                                </span>
                                {/* The classified reason, when it says more than the kind already did. */}
                                {parsedError &&
                                    parsedError.detail !== parsedError.title &&
                                    parsedError.detail !== readErrorSentence(parsedError.kind, { plural: noun }) && (
                                        <span className="max-w-xl text-meta text-text-dim">{parsedError.detail}</span>
                                    )}
                                {parsedError && (
                                    <ReadErrorHints
                                        kind={parsedError.kind}
                                        noun={noun}
                                        narrowable={allNamespaces && !clusterScoped}
                                    />
                                )}
                            </div>
                            {retry && (
                                <Button variant="outline" size="sm" onClick={() => void retry()}>
                                    Retry
                                </Button>
                            )}
                        </div>
                    ) : filteredData.length === 0 ? (
                        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-body text-text-muted">
                            {rows.length === 0 ? emptyCopy : `No ${noun} match “${search.trim()}”.`}
                        </div>
                    ) : (
                        <DataTable
                            table={table}
                            onRowClick={rowClick}
                            groupBy={groupBy}
                            rowProps={rowProps}
                            containerClassName="min-h-0 flex-1"
                            testId={testId}
                        />
                    )}
                    <div className="flex items-center border-t border-border px-3.5 py-2.5 text-meta text-text-muted">
                        <span>
                            <span className="font-mono text-foreground tabular-nums">{resultCount}</span>{' '}
                            {queryText && `of ${rows.length} `}
                            {resultCount === 1 ? 'result' : 'results'}
                            {footer ? ` · ${footer}` : ''}
                        </span>
                        {pageCount > 1 && (
                            <>
                                <div className="flex-1" />
                                <div className="flex items-center gap-2">
                                    <span className="font-mono tabular-nums">
                                        Page {pageIndex + 1} / {pageCount}
                                    </span>
                                    <Button
                                        variant="outline"
                                        size="xs"
                                        onClick={() => table.previousPage()}
                                        disabled={!table.getCanPreviousPage()}
                                    >
                                        Prev
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="xs"
                                        onClick={() => table.nextPage()}
                                        disabled={!table.getCanNextPage()}
                                    >
                                        Next
                                    </Button>
                                </div>
                            </>
                        )}
                    </div>
                </Card>
            </div>
        </div>
    );
}
