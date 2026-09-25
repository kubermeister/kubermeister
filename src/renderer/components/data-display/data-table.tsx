import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { flexRender, type Row, type Table as TanstackTable } from '@tanstack/react-table';
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

interface DataTableProps<TData> {
    table: TanstackTable<TData>;
    onRowClick?: (row: TData) => void;
    /**
     * Group rows under headings by this key. The rows keep their order inside a group, so grouping
     * only adds the headings: a list sorted by age stays sorted by age within each node or owner.
     */
    groupBy?: (row: TData) => string;
    /** Extra attributes per row (`data-*` hooks for tests and styling). */
    rowProps?: (row: TData) => Record<string, string>;
    containerClassName?: string;
    testId?: string;
}

/** Height of one row, which is what the virtualiser measures against before rows are rendered. */
const ROW_HEIGHT = 37;

/**
 * Only the rows in view are mounted. A page of this list can hold thousands of objects, and the
 * cost of a list screen should be the size of the window rather than the size of the cluster.
 */
/** One entry of the virtualised list: a row, or the heading that opens a group of them. */
type Entry<TData> = { kind: 'row'; row: Row<TData> } | { kind: 'group'; label: string; count: number };

function entriesOf<TData>(rows: Row<TData>[], groupBy?: (row: TData) => string): Entry<TData>[] {
    if (!groupBy) return rows.map((row) => ({ kind: 'row', row }));
    const entries: Entry<TData>[] = [];
    let current: string | null = null;
    let heading: Extract<Entry<TData>, { kind: 'group' }> | null = null;
    for (const row of rows) {
        const label = groupBy(row.original);
        if (label !== current) {
            current = label;
            heading = { kind: 'group', label, count: 0 };
            entries.push(heading);
        }
        if (heading) heading.count += 1;
        entries.push({ kind: 'row', row });
    }
    return entries;
}

export function DataTable<TData>({
    table,
    onRowClick,
    groupBy,
    rowProps,
    containerClassName,
    testId,
}: DataTableProps<TData>) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const rows = table.getRowModel().rows;
    const entries = entriesOf(rows, groupBy);
    const columnCount = table.getVisibleFlatColumns().length;
    const virtualizer = useVirtualizer({
        count: entries.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
        // A first guess, replaced once the table is measured; without one nothing mounts until
        // layout has run and the first paint of a list is empty.
        initialRect: { width: 1200, height: 800 },
    });
    const items = virtualizer.getVirtualItems();
    const before = items.length > 0 ? items[0]!.start : 0;
    const after = items.length > 0 ? virtualizer.getTotalSize() - items[items.length - 1]!.end : 0;

    return (
        <Table
            containerRef={scrollRef}
            containerClassName={cn('overflow-auto', containerClassName)}
            data-testid={testId}
        >
            <TableHeader className="sticky top-0 z-10 bg-card">
                {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id} className="border-border hover:bg-transparent">
                        {headerGroup.headers.map((header) => {
                            const size = header.column.columnDef.size;
                            const sorted = header.column.getIsSorted();
                            const label = header.isPlaceholder
                                ? null
                                : flexRender(header.column.columnDef.header, header.getContext());
                            return (
                                <TableHead
                                    key={header.id}
                                    style={size ? { width: `${size}px` } : undefined}
                                    aria-sort={
                                        sorted === 'asc'
                                            ? 'ascending'
                                            : sorted === 'desc'
                                              ? 'descending'
                                              : header.column.getCanSort()
                                                ? 'none'
                                                : undefined
                                    }
                                    className="h-9 text-caption font-medium tracking-wider text-text-muted uppercase"
                                >
                                    {header.column.getCanSort() ? (
                                        <button
                                            type="button"
                                            onClick={header.column.getToggleSortingHandler()}
                                            className="flex cursor-pointer items-center gap-1 select-none hover:text-text-2"
                                        >
                                            {label}
                                            {sorted === 'asc' ? (
                                                <ArrowUpIcon className="size-3" />
                                            ) : sorted === 'desc' ? (
                                                <ArrowDownIcon className="size-3" />
                                            ) : (
                                                <ChevronsUpDownIcon className="size-3 opacity-40" />
                                            )}
                                        </button>
                                    ) : (
                                        label
                                    )}
                                </TableHead>
                            );
                        })}
                    </TableRow>
                ))}
            </TableHeader>
            <TableBody>
                {/* Spacer rows stand in for what is scrolled past, so the scrollbar is honest
                    without the rows themselves being in the document. */}
                {before > 0 && <tr style={{ height: `${before}px` }} aria-hidden />}
                {items.map((item) => {
                    const entry = entries[item.index]!;
                    if (entry.kind === 'group') {
                        return (
                            <TableRow
                                key={`group:${entry.label}`}
                                ref={virtualizer.measureElement}
                                data-index={item.index}
                                data-group={entry.label}
                                className="border-border bg-elev-1 hover:bg-elev-1"
                            >
                                <TableCell
                                    colSpan={columnCount}
                                    className="px-3 py-1.5 text-caption font-medium tracking-wider text-text-muted uppercase"
                                >
                                    {entry.label}
                                    <span className="ml-2 tabular-nums">{entry.count}</span>
                                </TableCell>
                            </TableRow>
                        );
                    }
                    const row = entry.row;
                    return (
                        <TableRow
                            key={row.id}
                            ref={virtualizer.measureElement}
                            data-index={item.index}
                            {...rowProps?.(row.original)}
                            // The whole row is a click target for convenience; keyboard users reach the
                            // detail through the Name cell's link, so the row itself is not focusable.
                            onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                            className={cn('group/row border-border hover:bg-elev-2', onRowClick && 'cursor-pointer')}
                        >
                            {row.getVisibleCells().map((cell) => (
                                <TableCell key={cell.id} className="px-3 py-2.5 text-body text-text-2">
                                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                </TableCell>
                            ))}
                        </TableRow>
                    );
                })}
                {after > 0 && <tr style={{ height: `${after}px` }} aria-hidden />}
            </TableBody>
        </Table>
    );
}
