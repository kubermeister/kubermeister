import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoutes } from './helpers';

const invoke = vi.fn();
const subscribe = vi.fn(() => () => {});
const stream = vi.fn(() => ({ stop: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    subscribe,
    stream,
}));

const { routeTree } = await import('@/routeTree.gen');
const { IpcError } = await import('@/lib/ipc');

const columns = [
    { name: 'Size', type: 'string', jsonPath: '.spec.size' },
    { name: 'Ready', type: 'boolean', jsonPath: '.status.ready' },
];
const left = {
    name: 'left',
    namespace: 'team-a',
    age: '1h',
    cells: { '.spec.size': 'large', '.status.ready': 'true' },
};
const detail = { ...left, labels: [['app', 'widget']], annotations: [] };
const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'context.current': { name: 'alpha', cluster: 'a', user: 'u', current: true },
    'namespaces.list': [{ name: 'team-a', tone: 'accent' }],
    'namespace.active': { name: 'team-a' },
    'cluster.active': null,
    'events.forObject': [],
    'customResources.list': { kind: 'Widget', namespaced: true, columns, items: [left] },
    'customResources.get': { kind: 'Widget', namespaced: true, columns, item: detail },
    'customResources.getYaml': { yaml: 'apiVersion: example.com/v1\nkind: Widget\n', kind: 'Widget' },
    'resources.get': {
        kind: 'CustomResourceDefinition',
        item: {
            name: 'widgets.example.com',
            group: 'example.com',
            version: 'v1',
            scope: 'Namespaced',
            kind: 'Widget',
            age: '2d',
            labels: [],
            annotations: [],
        },
    },
};

beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (channel: string) => data[channel]);
});

describe('custom resource instances', () => {
    it('renders the columns the definition asked for, not columns the app chose', async () => {
        renderRoutes(routeTree, '/addons/instances/widgets.example.com');
        const table = await screen.findByTestId('instances-table');
        expect(invoke).toHaveBeenCalledWith('customResources.list', { crd: 'widgets.example.com' });
        expect(
            within(table)
                .getAllByRole('columnheader')
                .map((header) => header.textContent),
        ).toEqual(['Name', 'Size', 'Ready', 'Age']);
        const row = table.querySelector('[data-instance="left"]') as HTMLElement;
        expect(row).toHaveTextContent('large');
        expect(within(row).getByRole('link', { name: 'left' })).toHaveAttribute(
            'href',
            '/addons/instances/widgets.example.com/team-a/left',
        );
    });

    it('takes its heading from the kind the definition names', async () => {
        renderRoutes(routeTree, '/addons/instances/widgets.example.com');
        expect(await screen.findByRole('heading', { name: 'Widget' })).toBeInTheDocument();
    });

    it('opens an instance, showing its cells and its manifest', async () => {
        renderRoutes(routeTree, '/addons/instances/widgets.example.com/team-a/left');
        const page = await screen.findByTestId('instance-page');
        await waitFor(() => expect(page).toHaveTextContent('Size'));
        expect(page).toHaveTextContent('large');
        expect(invoke).toHaveBeenCalledWith('customResources.get', {
            crd: 'widgets.example.com',
            name: 'left',
            namespace: 'team-a',
        });

        const rail = within(page).getByRole('tablist');
        await userEvent.click(within(rail).getByRole('tab', { name: /Manifest/ }));
        // A custom resource cannot go through resources.getYaml, whose input is the registry's kinds.
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('customResources.getYaml', {
                crd: 'widgets.example.com',
                name: 'left',
                namespace: 'team-a',
            }),
        );
        expect(invoke).not.toHaveBeenCalledWith('resources.getYaml', expect.anything());
    });

    it('reads a cluster-scoped instance without a namespace, from its placeholder segment', async () => {
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'customResources.get') {
                return { kind: 'Widget', namespaced: false, columns, item: { ...detail, namespace: '' } };
            }
            return data[channel];
        });
        renderRoutes(routeTree, '/addons/instances/widgets.example.com/-/global');
        await screen.findByTestId('instance-page');
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('customResources.get', {
                crd: 'widgets.example.com',
                name: 'global',
                namespace: undefined,
            }),
        );
    });

    it('names no namespace for a missing cluster-scoped instance', async () => {
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'customResources.get') {
                throw new IpcError({ kind: 'notFound', detail: 'widgets "gone" not found', op: 'customResources.get' });
            }
            return data[channel];
        });
        renderRoutes(routeTree, '/addons/instances/widgets.example.com/-/gone');
        expect(await screen.findByTestId('not-found')).toHaveTextContent('“gone” was not found.');
        expect(screen.getByTestId('not-found')).not.toHaveTextContent('namespace');
    });

    it('offers the instances from the definition that describes them', async () => {
        renderRoutes(routeTree, '/addons/crds/widgets.example.com');
        const page = await screen.findByTestId('crd-page');
        const link = await within(page).findByRole('link', { name: /View instances/ });
        expect(link).toHaveAttribute('href', '/addons/instances/widgets.example.com');
    });
});
