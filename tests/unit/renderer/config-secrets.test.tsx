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

const configMap = { name: 'app-config', namespace: 'team-a', keys: 2, size: '40 B', age: '1h' };
const secret = { name: 'app-secret', namespace: 'team-a', type: 'Opaque', keys: 2, age: '1h' };
const meta = { labels: [['app', 'web']], annotations: [] };
const entries = [
    { key: 'greeting', contentType: 'text/plain', size: '5 B', value: 'hello-from-e2e' },
    { key: 'nginx.conf', contentType: 'text/yaml', size: '23 B', value: 'server {\n  listen 80;\n}' },
];
const secretEntries = [
    { key: 'password', masked: '••••••••' },
    { key: 'token', masked: '••••••••' },
];
const rows: Record<string, unknown[]> = { ConfigMap: [configMap], Secret: [secret] };
const details: Record<string, unknown> = { ConfigMap: { ...configMap, ...meta }, Secret: { ...secret, ...meta } };
const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'context.current': { name: 'alpha', cluster: 'a', user: 'u', current: true },
    'namespaces.list': [{ name: 'team-a', tone: 'accent' }],
    'namespace.active': { name: 'team-a' },
    'cluster.active': null,
    'events.forObject': [],
    'configMaps.entries': entries,
    'secrets.entries': secretEntries,
};

beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (channel: string, input: { kind?: string }) => {
        if (channel === 'resources.list') return { kind: input.kind, items: rows[input.kind!] ?? [] };
        if (channel === 'resources.get') return { kind: input.kind, item: details[input.kind!] ?? null };
        return data[channel];
    });
});

describe('config map screens', () => {
    it('lists config maps with their key count and size', async () => {
        renderRoutes(routeTree, '/workloads/configmaps');
        const table = await screen.findByTestId('configmaps-table');
        const row = table.querySelector('[data-configmap="app-config"]') as HTMLElement;
        expect(within(row).getByRole('link', { name: 'app-config' })).toHaveAttribute(
            'href',
            '/workloads/configmaps/team-a/app-config',
        );
        expect(row).toHaveTextContent('40 B');
        expect(
            within(table)
                .getAllByRole('columnheader')
                .map((h) => h.textContent),
        ).toEqual([
            // The blank leading header belongs to the selection checkbox column.
            '',
            'Name',
            'Keys',
            'Size',
            'Age',
        ]);
    });

    it('shows one card per entry with its content type and value', async () => {
        renderRoutes(routeTree, '/workloads/configmaps/team-a/app-config');
        const page = await screen.findByTestId('configmap-page');
        await waitFor(() => expect(page).toHaveTextContent('keys: 2'));
        const rail = within(page).getByRole('tablist');
        expect(
            within(rail)
                .getAllByRole('tab')
                .map((t) => t.textContent),
        ).toEqual(['Overview', 'Events', 'Entries2', 'ManifestYAML', 'Labels1']);
        await userEvent.click(within(rail).getByRole('tab', { name: /Entries/ }));
        const panel = within(page).getByTestId('configmap-entries');
        expect(panel).toHaveTextContent('greeting');
        expect(panel).toHaveTextContent('text/plain · 5 B');
        expect(panel).toHaveTextContent('hello-from-e2e');
        expect(panel).toHaveTextContent('text/yaml · 23 B');
        expect(invoke).toHaveBeenCalledWith('configMaps.entries', { name: 'app-config', namespace: 'team-a' });
    });
});

describe('secret screens', () => {
    it('lists secrets with their type and key count', async () => {
        renderRoutes(routeTree, '/workloads/secrets');
        const table = await screen.findByTestId('secrets-table');
        const row = table.querySelector('[data-secret="app-secret"]') as HTMLElement;
        expect(row).toHaveTextContent('Opaque');
        expect(within(row).getByRole('link', { name: 'app-secret' })).toHaveAttribute(
            'href',
            '/workloads/secrets/team-a/app-secret',
        );
    });

    it('masks every value in the Keys tab and never renders a plaintext value', async () => {
        renderRoutes(routeTree, '/workloads/secrets/team-a/app-secret');
        const page = await screen.findByTestId('secret-page');
        await waitFor(() => expect(page).toHaveTextContent('type: Opaque'));
        await userEvent.click(within(page).getByRole('tab', { name: /Keys/ }));
        const table = within(page).getByTestId('secret-keys');
        expect(within(table).getByRole('cell', { name: 'password' })).toBeInTheDocument();
        expect(within(table).getAllByRole('cell', { name: '••••••••' })).toHaveLength(2);
        expect(page.textContent).not.toContain('super-secret-value');
        expect(invoke).toHaveBeenCalledWith('secrets.entries', { name: 'app-secret', namespace: 'team-a' });
        // Every value is behind a control of its own; the reads they make are covered in
        // `secret-reveal.test.tsx`, so no value is asked for here.
        expect(within(table).getByRole('button', { name: 'Reveal password' })).toBeInTheDocument();
        expect(within(table).getByRole('button', { name: 'Copy password' })).toBeInTheDocument();
        expect(invoke).not.toHaveBeenCalledWith('secrets.reveal', expect.anything());
    });

    it('reports a missing secret as not found', async () => {
        invoke.mockImplementation(async (channel: string, input: { kind?: string }) =>
            channel === 'resources.get' ? { kind: input.kind, item: null } : data[channel],
        );
        renderRoutes(routeTree, '/workloads/secrets/team-a/ghost');
        expect(await screen.findByTestId('not-found')).toHaveTextContent(
            'Secret “ghost” was not found in namespace “team-a”.',
        );
    });
});
