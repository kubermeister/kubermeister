import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoxIcon, CalendarClockIcon, FileCodeIcon, HeartIcon, ScrollIcon, TerminalIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { EditResourceButton } from '@/components/templates/edit-resource-button';
import { useRegisterManifestEdit } from '@/components/templates/manifest-edit';
import { KeyValueCard, labelsTab, overviewTab, ResourceDetail } from '@/components/templates/resource-detail';

vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke: vi.fn(),
}));

type Props = Partial<Parameters<typeof ResourceDetail>[0]>;
const ready = { isPending: false, isError: false, isSuccess: true, refetch: vi.fn() };

const groups = [
    {
        label: 'OBSERVE',
        items: [
            { id: 'overview', label: 'Overview', icon: HeartIcon, content: <p>overview body</p> },
            { id: 'events', label: 'Events', icon: CalendarClockIcon, content: <p>events body</p> },
            {
                id: 'logs',
                label: 'Logs',
                icon: ScrollIcon,
                fill: true,
                keepMounted: true,
                content: <FollowStub />,
                hint: 'live',
            },
        ],
    },
    {
        label: 'CONNECT',
        items: [
            { id: 'manifest', label: 'Manifest', icon: FileCodeIcon, content: <ManifestStub /> },
            { id: 'shell', label: 'Shell', icon: TerminalIcon, count: 2, content: <p>shell body</p> },
        ],
    },
];

/** A panel with live state, as the Logs tab has, counting how often it mounts and unmounts. */
const follow = { mounts: 0, unmounts: 0 };
function FollowStub() {
    useEffect(() => {
        follow.mounts++;
        return () => {
            follow.unmounts++;
        };
    }, []);
    return <p>logs body</p>;
}

/** The Manifest tab's side of the Edit handshake, standing in for the real panel. */
function ManifestStub() {
    const [editing, setEditing] = useState(false);
    useRegisterManifestEdit(() => setEditing(true));
    return <p>{editing ? 'manifest editing' : 'manifest reading'}</p>;
}

/**
 * Mount the detail where a screen does, on a route whose optional last segment is the tab, with a
 * list and another object to leave it for.
 */
function renderDetail(props: Props, path = '/pods/web-1') {
    const root = createRootRoute({ component: Outlet });
    const detail = createRoute({
        getParentRoute: () => root,
        path: '/pods/$name/{-$tab}',
        component: () => (
            <ResourceDetail
                icon={BoxIcon}
                eyebrow="Pod"
                title="web-1"
                groups={groups}
                query={ready}
                found
                kind="Pod"
                backTo="/list"
                testId="detail"
                {...props}
            />
        ),
    });
    const list = createRoute({ getParentRoute: () => root, path: '/list', component: () => <p>the list</p> });
    const node = createRoute({ getParentRoute: () => root, path: '/node', component: () => <p>the node</p> });
    const router = createRouter({
        routeTree: root.addChildren([detail, list, node]),
        history: createMemoryHistory({ initialEntries: ['/list', path] }),
    });
    render(
        <QueryClientProvider client={new QueryClient()}>
            <RouterProvider router={router} />
        </QueryClientProvider>,
    );
    return router;
}

const selected = (name: RegExp) => expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');

describe('ResourceDetail', () => {
    it('renders the header, grouped rail with counts and hints, and the first tab', async () => {
        renderDetail({});
        expect(await screen.findByText('web-1')).toBeInTheDocument();
        const rail = screen.getByRole('tablist');
        expect(rail).toHaveAttribute('aria-orientation', 'vertical');
        expect(rail).toHaveTextContent('OBSERVE');
        expect(rail).toHaveTextContent('CONNECT');
        expect(within(rail).getAllByRole('tab')).toHaveLength(5);
        expect(within(rail).getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');
        expect(within(rail).getByRole('tab', { name: /Shell/ })).toHaveTextContent('2');
        expect(within(rail).getByRole('tab', { name: /Logs/ })).toHaveTextContent('live');
        expect(screen.getByText('overview body')).toBeVisible();
        expect(screen.queryByText('shell body')).not.toBeInTheDocument();
        // keepMounted panels exist hidden from the start so their live state can build up.
        expect(screen.getByText('logs body')).not.toBeVisible();
        expect(screen.getByTestId('detail-body')).toBeInTheDocument();
    });

    it('switches tabs on click, keeps mounted panels hidden, and unmounts the rest', async () => {
        renderDetail({});
        await userEvent.click(await screen.findByRole('tab', { name: /Shell/ }));
        expect(await screen.findByText('shell body')).toBeVisible();
        expect(screen.queryByText('overview body')).not.toBeInTheDocument();
        expect(screen.getByText('logs body')).not.toBeVisible();
        await userEvent.click(screen.getByRole('tab', { name: /Logs/ }));
        await waitFor(() => expect(screen.getByText('logs body')).toBeVisible());
        expect(screen.getByRole('tabpanel')).toHaveClass('overflow-hidden');
    });

    it('moves the selection with arrow keys, wrapping around the flat order', async () => {
        renderDetail({});
        const overview = await screen.findByRole('tab', { name: /Overview/ });
        overview.focus();
        await userEvent.keyboard('{ArrowDown}{ArrowDown}');
        await waitFor(() => selected(/Logs/));
        expect(screen.getByRole('tab', { name: /Logs/ })).toHaveFocus();
        await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
        await waitFor(() => selected(/Shell/));
        await userEvent.keyboard('{ArrowRight}');
        await waitFor(() => selected(/Overview/));
        await userEvent.keyboard('{Enter}');
        selected(/Overview/);
    });

    it('shows the tab the route names, and the first tab for the bare path or an unknown id', async () => {
        renderDetail({}, '/pods/web-1/shell');
        expect(await screen.findByText('shell body')).toBeVisible();
        selected(/Shell/);
    });

    it.each(['/pods/web-1', '/pods/web-1/overview', '/pods/web-1/renamed-since'])(
        'opens %s on the first tab',
        async (path) => {
            renderDetail({}, path);
            expect(await screen.findByText('overview body')).toBeVisible();
            selected(/Overview/);
        },
    );

    it('writes a tab into the route with replace, and the first tab as the bare path', async () => {
        const router = renderDetail({});
        await userEvent.click(await screen.findByRole('tab', { name: /Shell/ }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/pods/web-1/shell'));
        await userEvent.click(screen.getByRole('tab', { name: /Events/ }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/pods/web-1/events'));
        screen.getByRole('tab', { name: /Events/ }).focus();
        await userEvent.keyboard('{ArrowUp}');
        await waitFor(() => expect(router.state.location.pathname).toBe('/pods/web-1'));
        // The list and the object: three switches added nothing to the history.
        expect(router.history.length).toBe(2);
    });

    it('leaves the object in one Back after several switches', async () => {
        const router = renderDetail({});
        await userEvent.click(await screen.findByRole('tab', { name: /Shell/ }));
        await userEvent.click(screen.getByRole('tab', { name: /Events/ }));
        await userEvent.click(screen.getByRole('tab', { name: /Logs/ }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/pods/web-1/logs'));
        router.history.back();
        expect(await screen.findByText('the list')).toBeInTheDocument();
    });

    it('returns to the tab it was left on', async () => {
        const router = renderDetail({});
        await userEvent.click(await screen.findByRole('tab', { name: /Logs/ }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/pods/web-1/logs'));
        await router.navigate({ to: '/node' });
        expect(await screen.findByText('the node')).toBeInTheDocument();
        router.history.back();
        await waitFor(() => selected(/Logs/));
        expect(screen.getByText('logs body')).toBeVisible();
    });

    it('keeps a live panel mounted through a switch to Events and back', async () => {
        follow.mounts = 0;
        follow.unmounts = 0;
        renderDetail({}, '/pods/web-1/logs');
        expect(await screen.findByText('logs body')).toBeVisible();
        await userEvent.click(screen.getByRole('tab', { name: /Events/ }));
        expect(await screen.findByText('events body')).toBeVisible();
        await userEvent.click(screen.getByRole('tab', { name: /Logs/ }));
        await waitFor(() => expect(screen.getByText('logs body')).toBeVisible());
        expect(follow).toEqual({ mounts: 1, unmounts: 0 });
    });

    it('opens the Manifest tab in edit mode from the header, pushing a history entry', async () => {
        const router = renderDetail({ actions: <EditResourceButton /> });
        await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
        expect(await screen.findByText('manifest editing')).toBeVisible();
        expect(router.state.location.pathname).toBe('/pods/web-1/manifest');
        router.history.back();
        await waitFor(() => selected(/Overview/));
    });

    it('shows skeletons while loading', async () => {
        renderDetail({ query: { ...ready, isPending: true, isSuccess: false } });
        expect(await screen.findByRole('status', { name: 'Loading' })).toBeInTheDocument();
        expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    });

    it('shows the error panel with retry and a link back to the list', async () => {
        const refetch = vi.fn();
        const router = renderDetail({ query: { ...ready, isError: true, isSuccess: false, refetch } });
        expect(await screen.findByTestId('detail-error')).toHaveTextContent('Failed to load Pod.');
        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(refetch).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole('link', { name: 'Back to list' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/list'));
    });

    it('shows not found naming the namespace when known, otherwise the current one', async () => {
        renderDetail({ found: false, namespace: 'team-a' });
        expect(await screen.findByTestId('not-found')).toHaveTextContent(
            'Pod “web-1” was not found in namespace “team-a”.',
        );
        expect(screen.getByRole('link', { name: 'Back to list' })).toHaveAttribute('href', '/list');
    });

    it('falls back to generic copy without a kind or namespace and hides links without backTo', async () => {
        renderDetail({ found: false, kind: undefined, backTo: undefined });
        expect(await screen.findByTestId('not-found')).toHaveTextContent(
            'Resource “web-1” was not found in the current namespace.',
        );
        expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });
});

describe('tab factories', () => {
    it('overviewTab renders a details grid and labelsTab counts the labels', () => {
        const overview = overviewTab([['Node', 'n1']]);
        render(<>{overview.content}</>);
        expect(screen.getByText('Details')).toBeInTheDocument();
        expect(screen.getByText('n1')).toBeInTheDocument();

        const labels = labelsTab({ labels: [['app', 'web']], annotations: [] });
        expect(labels.count).toBe(1);
        expect(labelsTab(undefined).count).toBeUndefined();
        expect(labelsTab({ labels: [], annotations: [] }).count).toBeUndefined();
        render(<>{labels.content}</>);
        expect(screen.getByText('app')).toBeInTheDocument();
        expect(screen.getByText('None.')).toBeInTheDocument();
    });

    it('KeyValueCard lists rows in mono with the last row unbordered', () => {
        render(
            <KeyValueCard
                title="Labels"
                rows={[
                    ['a', '1'],
                    ['b', '2'],
                ]}
            />,
        );
        expect(screen.getByText('a').parentElement).toHaveClass('border-b');
        expect(screen.getByText('b').parentElement).not.toHaveClass('border-b');
    });
});
