import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    RouterProvider,
} from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LayersIcon } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ageColumn, nameColumn, statusColumn, textColumn } from '@/components/templates/list-columns';
import { ResourceListPage } from '@/components/templates/resource-list-page';
import { ThemeProvider } from '@/components/theme-provider';
import { invoke, IpcError } from '@/lib/ipc';

// The page reads the active scope to bucket row selection; nothing here depends on the values.
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke: vi.fn(async (channel: string) =>
        channel === 'context.current'
            ? { name: 'alpha', cluster: 'a', user: 'u', current: true }
            : { name: 'team-a', tone: 'accent' },
    ),
}));
import type { StatusTone } from '@/lib/status';

interface Row {
    name: string;
    namespace: string;
    status: 'Running' | 'Pending';
    restarts: number;
    age: string;
}
const TONES: Record<Row['status'], StatusTone> = { Running: 'ok', Pending: 'warn' };
const columns: ColumnDef<Row>[] = [
    nameColumn<Row>(),
    statusColumn<Row, Row['status']>(TONES),
    textColumn<Row>('restarts', 'Restarts', { numeric: true }),
    ageColumn<Row>(),
];
const rows: Row[] = [
    { name: 'web-1', namespace: 'team-a', status: 'Running', restarts: 0, age: '3d' },
    { name: 'api-1', namespace: 'team-a', status: 'Pending', restarts: 2, age: '45s' },
    { name: 'db-1', namespace: 'team-a', status: 'Running', restarts: 1, age: '1h42m' },
];

type Props = Partial<Parameters<typeof ResourceListPage<Row>>[0]>;
const okQuery = (data: Row[]) => ({ data, isPending: false, isError: false, error: null, refetch: vi.fn() });

/** Mount the page at `/` inside a tiny router so row navigation has somewhere to go. */
function renderPage(props: Props) {
    const root = createRootRoute({ component: Outlet });
    const index = createRoute({
        getParentRoute: () => root,
        path: '/',
        component: () => (
            <ResourceListPage<Row> icon={LayersIcon} title="Pods" columns={columns} query={okQuery(rows)} {...props} />
        ),
    });
    const detail = createRoute({ getParentRoute: () => root, path: '/$rest', component: () => <p>detail</p> });
    const router = createRouter({
        routeTree: root.addChildren([index, detail]),
        history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    render(
        <ThemeProvider>
            <QueryClientProvider client={new QueryClient()}>
                <RouterProvider router={router} />
            </QueryClientProvider>
        </ThemeProvider>,
    );
    return router;
}

const bodyRows = () => within(screen.getByTestId('list')).getAllByRole('row').slice(1);
const firstCells = () => bodyRows().map((row) => within(row).getAllByRole('cell')[0]?.textContent);

describe('ResourceListPage', () => {
    it('renders the title, count badge, rows with tones and the result footer', async () => {
        renderPage({ testId: 'list' });
        expect(await screen.findByRole('heading', { name: 'Pods' })).toBeInTheDocument();
        expect(screen.getByTestId('resource-list')).toHaveTextContent('3 results');
        expect(bodyRows()).toHaveLength(3);
        expect(within(screen.getByTestId('list')).getByText('Pending')).toHaveAttribute('data-tone', 'warn');
        expect(screen.queryByText('Namespace')).not.toBeInTheDocument();
    });

    it('shows skeletons while loading and the empty copy when nothing comes back', async () => {
        renderPage({ query: { data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() } });
        await screen.findByRole('heading', { name: 'Pods' });
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        expect(screen.getByTestId('resource-list').querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(
            0,
        );
    });

    it('uses the noun in generated copy and the empty message override', async () => {
        renderPage({ query: okQuery([]), nounPlural: 'CRDs', emptyMessage: 'Nothing here.' });
        expect(await screen.findByText('Nothing here.')).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: 'Search CRDs…' })).toBeInTheDocument();
    });

    it('explains a classified failure per kind and offers a retry', async () => {
        const refetch = vi.fn();
        const failing = (kind: string) =>
            ({
                data: undefined,
                isPending: false,
                isError: true,
                refetch,
                error: new IpcError({ kind, detail: 'd', op: 'x' }),
            }) as Props['query'];
        const first = renderPage({ query: failing('unauthorized') });
        expect(await screen.findByText("Your session isn't authenticated to the cluster.")).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(refetch).toHaveBeenCalledOnce();
        void first;
    });

    it('adds the classified reason under the generic sentence when it says more', async () => {
        renderPage({
            query: {
                data: undefined,
                isPending: false,
                isError: true,
                refetch: vi.fn(),
                error: new IpcError({
                    kind: 'timeout',
                    detail: 'The cluster did not answer within 15 s. It may be busy, or the connection slow.',
                    op: 'x',
                }),
            } as Props['query'],
        });
        expect(await screen.findByText('Cluster timed out')).toBeInTheDocument();
        expect(screen.getByText('The cluster took too long to return Pods.')).toBeInTheDocument();
        expect(
            screen.getByText('The cluster did not answer within 15 s. It may be busy, or the connection slow.'),
        ).toBeInTheDocument();
    });

    it('hides a reason that only repeats the title or the generic sentence', async () => {
        renderPage({
            query: {
                data: undefined,
                isPending: false,
                isError: true,
                refetch: vi.fn(),
                error: new IpcError({ kind: 'unreachable', detail: 'The cluster API server is unreachable.', op: 'x' }),
            } as Props['query'],
        });
        expect(await screen.findAllByText('The cluster API server is unreachable.')).toHaveLength(1);
        expect(screen.getAllByText('Cluster unreachable')).toHaveLength(1);
    });

    describe('a timeout under All namespaces', () => {
        const HINT = /viewing all namespaces/;
        const timedOut = () =>
            ({
                data: undefined,
                isPending: false,
                isError: true,
                refetch: vi.fn(),
                error: new IpcError({ kind: 'timeout', detail: 'The cluster did not answer within 60 s.', op: 'x' }),
            }) as Props['query'];
        const scoped = (namespace: string | null) =>
            vi
                .mocked(invoke)
                .mockImplementation(async (channel: string) =>
                    channel === 'context.current'
                        ? { name: 'alpha', cluster: 'a', user: 'u', current: true }
                        : { name: namespace },
                );
        afterEach(() => {
            scoped('team-a');
        });

        it('says that narrowing to one namespace would ask the cluster for less', async () => {
            scoped(null);
            renderPage({ query: timedOut() });
            expect(await screen.findByText('Cluster timed out')).toBeInTheDocument();
            const hint = await screen.findByTestId('all-namespaces-hint');
            expect(hint).toHaveTextContent(HINT);
            expect(hint).toHaveTextContent('Selecting a namespace in the top bar');
        });

        it('points at the read-timeout setting whichever scope is selected', async () => {
            scoped('team-a');
            renderPage({ query: timedOut() });
            const hint = await screen.findByTestId('read-timeout-hint');
            expect(hint).toHaveTextContent('raise the read timeout');
            expect(within(hint).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings/data');
        });

        it('says nothing about namespaces when one is already selected', async () => {
            scoped('team-a');
            renderPage({ query: timedOut() });
            expect(await screen.findByText('Cluster timed out')).toBeInTheDocument();
            expect(screen.queryByTestId('all-namespaces-hint')).not.toBeInTheDocument();
        });

        it('says nothing for a cluster-scoped kind, where a namespace would change nothing', async () => {
            scoped(null);
            renderPage({ query: timedOut(), clusterScoped: true });
            expect(await screen.findByText('Cluster timed out')).toBeInTheDocument();
            expect(screen.queryByTestId('all-namespaces-hint')).not.toBeInTheDocument();
        });

        it('is a hint about timeouts only, not about every failure', async () => {
            scoped(null);
            renderPage({
                query: {
                    data: undefined,
                    isPending: false,
                    isError: true,
                    refetch: vi.fn(),
                    error: new IpcError({ kind: 'forbidden', detail: 'denied', op: 'x' }),
                } as Props['query'],
            });
            expect(await screen.findByText('Access denied')).toBeInTheDocument();
            expect(screen.queryByTestId('all-namespaces-hint')).not.toBeInTheDocument();
            expect(screen.queryByTestId('read-timeout-hint')).not.toBeInTheDocument();
        });
    });

    it.each([
        ['forbidden', "You don't have permission to view Pods."],
        ['unreachable', 'The cluster API server is unreachable.'],
        ['timeout', 'The cluster took too long to return Pods.'],
        ['notFound', "Pods aren't available on this cluster."],
        ['conflict', 'Failed to load Pods.'],
    ])('describes a %s error', async (kind, copy) => {
        renderPage({
            query: {
                data: undefined,
                isPending: false,
                isError: true,
                refetch: vi.fn(),
                error: new IpcError({ kind, detail: 'd', op: 'x' }),
            } as Props['query'],
        });
        expect(await screen.findByText(copy)).toBeInTheDocument();
    });

    it('filters rows by the search box across visible columns and reports no matches', async () => {
        renderPage({ testId: 'list' });
        const search = await screen.findByRole('textbox', { name: 'Search Pods…' });
        await userEvent.type(search, 'pend');
        await waitFor(() => expect(bodyRows()).toHaveLength(1));
        expect(screen.getByTestId('resource-list')).toHaveTextContent('1 of 3 result');
        await userEvent.clear(search);
        await userEvent.type(search, 'zzz');
        expect(await screen.findByText('No Pods match “zzz”.')).toBeInTheDocument();
    });

    it('sorts by a column on header click, by duration for age, and reports the sort in the footer', async () => {
        renderPage({ testId: 'list' });
        await screen.findByTestId('list');
        const nameHeader = screen.getByRole('button', { name: 'Name' });
        await userEvent.click(nameHeader);
        expect(firstCells()).toEqual(['api-1', 'db-1', 'web-1']);
        expect(nameHeader.closest('th')).toHaveAttribute('aria-sort', 'ascending');
        expect(screen.getByTestId('resource-list')).toHaveTextContent('sorted by Name asc');
        await userEvent.click(nameHeader);
        expect(firstCells()).toEqual(['web-1', 'db-1', 'api-1']);
        expect(nameHeader.closest('th')).toHaveAttribute('aria-sort', 'descending');

        // Numeric accessors sort descending first, so the oldest row leads.
        await userEvent.click(screen.getByRole('button', { name: 'Age' }));
        expect(firstCells()).toEqual(['web-1', 'db-1', 'api-1']);
        await userEvent.click(screen.getByRole('button', { name: 'Age' }));
        expect(firstCells()).toEqual(['api-1', 'db-1', 'web-1']);
    });

    it('hides a column from the Columns menu and stops searching it', async () => {
        renderPage({ testId: 'list' });
        await screen.findByTestId('list');
        await userEvent.click(screen.getByRole('button', { name: 'Columns' }));
        await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Status' }));
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Status' })).not.toBeInTheDocument());
        await userEvent.keyboard('{Escape}');
        await userEvent.type(screen.getByRole('textbox'), 'Running');
        expect(await screen.findByText('No Pods match “Running”.')).toBeInTheDocument();
    });

    it('injects a Namespace column after Name when rows span several namespaces', async () => {
        renderPage({ testId: 'list', query: okQuery([rows[0]!, { ...rows[1]!, namespace: 'team-b' }]) });
        const list = await screen.findByTestId('list');
        const headers = within(list)
            .getAllByRole('columnheader')
            .map((h) => h.textContent);
        expect(headers.slice(0, 2)).toEqual(['Name', 'Namespace']);
        expect(list).toHaveTextContent('team-b');
    });

    it('navigates to the detail path on row click and exposes row attributes', async () => {
        const router = renderPage({
            testId: 'list',
            detailPath: (row) => `/${row.name}`,
            rowProps: (row) => ({ 'data-row': row.name }),
        });
        const list = await screen.findByTestId('list');
        const target = list.querySelector('[data-row="db-1"]');
        expect(target).not.toBeNull();
        await userEvent.click(within(target as HTMLElement).getByText('db-1'));
        await waitFor(() => expect(router.state.location.pathname).toBe('/db-1'));
    });

    it('renders only the rows in view, however many the list holds', async () => {
        const many = Array.from({ length: 2_000 }, (_, i) => ({
            ...rows[0]!,
            name: `pod-${String(i).padStart(4, '0')}`,
        }));
        renderPage({ testId: 'list', query: okQuery(many), footerNote: 'live' });
        await screen.findByTestId('list');
        // Two thousand objects, a screenful of DOM: the cost of the screen is the window's size.
        expect(bodyRows().length).toBeGreaterThan(0);
        expect(bodyRows().length).toBeLessThan(100);
        expect(screen.getByTestId('resource-list')).toHaveTextContent('2000 results · live');
    });

    it('pages a list too large to hold at once, and says where it is', async () => {
        const many = Array.from({ length: 600 }, (_, i) => ({
            ...rows[0]!,
            name: `pod-${String(i).padStart(3, '0')}`,
        }));
        renderPage({ testId: 'list', query: okQuery(many) });
        await screen.findByTestId('list');
        expect(screen.getByText('Page 1 / 2')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Prev' })).toBeDisabled();
        await userEvent.click(screen.getByRole('button', { name: 'Next' }));
        expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
        expect(screen.getByText('Page 2 / 2')).toBeInTheDocument();
    });

    it('refreshes every query from the toolbar button', async () => {
        renderPage({ testId: 'list', toolbar: <button>Extra</button> });
        await screen.findByTestId('list');
        expect(screen.getByRole('button', { name: 'Extra' })).toBeInTheDocument();
        const refresh = screen.getByRole('button', { name: 'Refresh' });
        await userEvent.click(refresh);
        await waitFor(() => expect(refresh).toHaveAttribute('aria-disabled', 'false'));
    });
});
