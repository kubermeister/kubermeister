import type { Kind } from '../../../shared/k8s/registry';
import { Checkbox } from '@/components/ui/checkbox';
import { ScaleControl } from '@/components/templates/scale-control';
import type { ColumnDef } from '@tanstack/react-table';
import type { LucideIcon } from 'lucide-react';
import { StatusBadge } from '@/components/data-display/status-badge';
import { usageTone, type StatusTone } from '@/lib/status';
import { Meter } from '@/components/data-display/meter';
import { NavLink } from '@/components/layout/nav-link';
import { cn } from '@/lib/utils';

/**
 * Factories for the column shapes copy-pasted across the list screens. Each returns a `ColumnDef`
 * with a sort accessor baked in, so ratios sort by fraction and ages by duration rather than
 * lexicographically. Pure parse helpers (`ageToSeconds`, `parseRatio`) are exported for unit tests.
 */

/** One canonical width for every Age column (kubectl ages fit comfortably). */
export const AGE_COLUMN_SIZE = 80;

const AGE_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** Parse a kubectl-style age string ("34d", "1h42m", "45s") to seconds so Age columns sort by duration. */
export function ageToSeconds(value: string): number {
    let total = 0;
    for (const match of value.matchAll(/(\d+)([smhd])/g)) {
        total += Number(match[1]) * (AGE_UNIT_SECONDS[match[2] ?? ''] ?? 0);
    }
    return total;
}

interface Ratio {
    completed: number;
    desired: number;
    /** completed / desired (0 when desired is 0), for numeric sorting. */
    ratio: number;
    /** True when every replica is ready and at least one is desired. */
    complete: boolean;
}

/** Parse an "n/m" ratio ("3/3", "1/5") into its parts, tolerating malformed input. */
export function parseRatio(value: string): Ratio {
    const [rawCompleted = NaN, rawDesired = NaN] = value.split('/').map((part) => Number(part.trim()));
    const completed = Number.isFinite(rawCompleted) ? rawCompleted : 0;
    const desired = Number.isFinite(rawDesired) ? rawDesired : 0;
    return {
        completed,
        desired,
        ratio: desired > 0 ? completed / desired : 0,
        complete: Number.isFinite(rawCompleted) && completed === desired && desired > 0,
    };
}

/** Keys of `T` whose value is a (possibly optional) string or number — the fields `textColumn` renders. */
type ScalarKey<T> = Extract<{ [K in keyof T]: T[K] extends string | number | undefined ? K : never }[keyof T], string>;

/** Stringify a scalar field by its typed key — no `Record<string, unknown>` cast, so a model rename
 * that removes the key is a compile error at the `textColumn`/`readyRatioColumn` call site. */
function scalar<T>(row: T, id: ScalarKey<T>): string {
    const value = row[id];
    return value == null ? '' : String(value);
}

/**
 * The primary "Name" column: brand-colored, optionally with a leading icon or monospace styling.
 * With `href` the name is a real link to the row's detail, so it has a URL and is keyboard reachable.
 */
export function nameColumn<T extends { name: string }>(
    options: { icon?: LucideIcon; mono?: boolean; href?: (row: T) => string } = {},
): ColumnDef<T> {
    const { icon: Icon, mono, href } = options;
    return {
        id: 'name',
        header: 'Name',
        accessorFn: (row) => row.name,
        cell: ({ row }) => {
            const className = cn('font-medium text-primary', mono && 'font-mono');
            return (
                <span className="flex items-center gap-2">
                    {Icon && <Icon className="size-3.5 shrink-0 text-text-muted" />}
                    {href ? (
                        <NavLink to={href(row.original)} className={cn(className, 'hover:underline')}>
                            {row.original.name}
                        </NavLink>
                    ) : (
                        <span className={className}>{row.original.name}</span>
                    )}
                </span>
            );
        },
    };
}

/** A plain text/number cell. `numeric` adds `tabular-nums`; `mono`/`small`/`muted`/`truncate` tune styling. */
export function textColumn<T>(
    id: ScalarKey<T>,
    header: string,
    options: {
        size?: number;
        mono?: boolean;
        small?: boolean;
        muted?: boolean;
        numeric?: boolean;
        truncate?: boolean;
    } = {},
): ColumnDef<T> {
    const { size, mono, small, muted, numeric, truncate } = options;
    return {
        id,
        header,
        size,
        accessorFn: (row) => row[id] as string | number,
        cell: ({ row }) => (
            <span
                className={cn(
                    muted ? 'text-text-muted' : 'text-text-2',
                    mono && 'font-mono',
                    small && 'text-meta',
                    numeric && 'tabular-nums',
                    truncate && 'block truncate',
                )}
            >
                {scalar(row.original, id)}
            </span>
        ),
    };
}

type BooleanKey<T> = Extract<{ [K in keyof T]: T[K] extends boolean ? K : never }[keyof T], string>;

/**
 * A boolean cell, in the API's own words rather than an icon: these flags read as `true`/`false`
 * in every manifest and every `kubectl get -o yaml`, and a tick would be one more thing to learn.
 */
export function flagColumn<T>(id: BooleanKey<T>, header: string, size = 120): ColumnDef<T> {
    return {
        id,
        header,
        size,
        accessorFn: (row) => row[id] as boolean,
        cell: ({ row }) => (
            <span className={(row.original[id] as boolean) ? 'text-text-2' : 'text-text-muted'}>
                {String(row.original[id])}
            </span>
        ),
    };
}

/**
 * The Namespace column, for "All namespaces" views where same-named objects in different namespaces
 * would otherwise be indistinguishable. `ResourceListPage` auto-injects this when rows span multiple
 * namespaces; screens with a bespoke namespace column keep their own.
 */
export function namespaceColumn<T extends { namespace?: string }>(): ColumnDef<T> {
    return {
        id: 'namespace',
        header: 'Namespace',
        size: 160,
        accessorFn: (row) => row.namespace ?? '',
        cell: ({ row }) => <span className="text-text-2">{row.original.namespace ?? '—'}</span>,
    };
}

/** The Age column — one canonical width, duration-aware sorting. */
export function ageColumn<T extends { age: string }>(): ColumnDef<T> {
    return {
        id: 'age',
        header: 'Age',
        size: AGE_COLUMN_SIZE,
        accessorFn: (row) => ageToSeconds(row.age),
        cell: ({ row }) => <span className="font-mono text-text-muted tabular-nums">{row.original.age}</span>,
    };
}

/** The Status column rendered as a `StatusBadge` toned by the kind's own status map, sortable by status name. */
export function statusColumn<T extends { status: S }, S extends string>(
    tones: Record<S, StatusTone>,
    options: { size?: number } = {},
): ColumnDef<T> {
    return {
        id: 'status',
        header: 'Status',
        size: options.size ?? 120,
        accessorFn: (row) => row.status,
        cell: ({ row }) => <StatusBadge tone={tones[row.original.status]}>{row.original.status}</StatusBadge>,
    };
}

/**
 * An "n/m" ratio column (e.g. Ready, Completions) toned by completeness — `ok` when fully ready,
 * `warn` otherwise — and sorted by the ready fraction, not lexically.
 */
export function readyRatioColumn<T>(id: ScalarKey<T>, header = 'Ready', size = 90): ColumnDef<T> {
    return {
        id,
        header,
        size,
        accessorFn: (row) => parseRatio(scalar(row, id)).ratio,
        cell: ({ row }) => {
            const value = scalar(row.original, id);
            return (
                <span className={cn('font-mono tabular-nums', parseRatio(value).complete ? 'text-ok' : 'text-warn')}>
                    {value}
                </span>
            );
        },
    };
}

/**
 * A usage-meter column driven by a percentage getter (0 to 100, or `null` when there is nothing to
 * measure against). Owns `usageTone` so the ok/warn/danger thresholds match everywhere. `label`
 * overrides the leading text (defaults to `${pct}%`) for screens that show raw magnitudes and
 * `emptyLabel` the text shown for a null percentage.
 */
export function meterColumn<T>(
    id: string,
    header: string,
    getPct: (row: T) => number | null,
    options: { size?: number; label?: (row: T) => string; labelClassName?: string; emptyLabel?: string } = {},
): ColumnDef<T> {
    const { size = 130, label, labelClassName = 'w-8', emptyLabel = 'no limit' } = options;
    return {
        id,
        header,
        size,
        accessorFn: (row) => getPct(row) ?? -1,
        cell: ({ row }) => {
            const pct = getPct(row.original);
            if (pct == null) return <span className="text-caption text-text-dim">{emptyLabel}</span>;
            return (
                <div className="flex items-center gap-2">
                    <span className={cn('font-mono text-meta tabular-nums', labelClassName)}>
                        {label ? label(row.original) : `${pct}%`}
                    </span>
                    <Meter value={pct} tone={usageTone(pct)} label={`${header} usage`} />
                </div>
            );
        },
    };
}

/**
 * The leading checkbox column, present only on lists that offer bulk delete. Clicks are kept from
 * the row so checking a box never opens the object.
 */
export function selectColumn<T>(): ColumnDef<T> {
    return {
        id: 'select',
        size: 32,
        enableSorting: false,
        enableHiding: false,
        header: ({ table }) => (
            <Checkbox
                checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && 'indeterminate')}
                onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
                aria-label="Select all rows on this page"
            />
        ),
        cell: ({ row }) => (
            <div
                className="flex items-center"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
            >
                <Checkbox
                    checked={row.getIsSelected()}
                    onCheckedChange={(value) => row.toggleSelected(!!value)}
                    aria-label="Select row"
                />
            </div>
        ),
    };
}

/** Inline replica steppers for a scalable kind, again keeping their clicks off the row. */
export function scaleColumn<T extends { name: string; namespace?: string; replicas?: number }>(
    kind: Kind,
    options: { size?: number } = {},
): ColumnDef<T> {
    return {
        id: 'scale',
        header: 'Scale',
        size: options.size ?? 140,
        enableSorting: false,
        enableHiding: false,
        cell: ({ row }) => (
            <div
                className="flex items-center"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
            >
                <ScaleControl
                    kind={kind}
                    name={row.original.name}
                    namespace={row.original.namespace}
                    replicas={row.original.replicas ?? 0}
                />
            </div>
        ),
    };
}
