import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoutes } from './helpers';
import { settingsFixture } from './settings-fixture';
import { readColumnVisibility, writeColumnVisibility } from '@/lib/persisted-columns';

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

const settings = settingsFixture({ updates: { mode: 'check' } });

const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'context.current': { name: 'alpha', cluster: 'a', user: 'u', current: true },
    'namespaces.list': [{ name: 'team-a', tone: 'accent' }],
    'namespace.active': { name: 'team-a' },
    'cluster.active': null,
    'settings.get': settings,
    'settings.set': settings,
    'resources.list': {
        kind: 'Pod',
        items: [
            {
                name: 'web-1',
                namespace: 'team-a',
                status: 'Running',
                ready: '1/1',
                restarts: 0,
                age: '1h',
                node: 'n1',
                owner: 'ReplicaSet/web-7d9',
                cpu: 0,
                mem: 0,
                cpuLimit: 0,
                memLimit: 0,
            },
        ],
    },
};

beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (channel: string) => data[channel]);
    localStorage.clear();
});

describe('remembered columns', () => {
    it('keeps hidden columns per screen and survives storage being unavailable', () => {
        writeColumnVisibility('pods-table', { restarts: false, age: true });
        // Only the hidden ones are worth keeping: a column shows unless it was hidden on purpose.
        expect(readColumnVisibility('pods-table')).toEqual({ restarts: false });
        expect(readColumnVisibility('other-table')).toEqual({});

        writeColumnVisibility('pods-table', { restarts: true });
        expect(readColumnVisibility('pods-table')).toEqual({});

        localStorage.setItem('km-columns:broken', 'not json');
        expect(readColumnVisibility('broken')).toEqual({});
        localStorage.setItem('km-columns:list', '["restarts"]');
        expect(readColumnVisibility('list')).toEqual({});
    });

    it('restores a hidden column on the screen that hid it', async () => {
        writeColumnVisibility('pods-table', { restarts: false });
        renderRoutes(routeTree, '/workloads/pods');
        const table = await screen.findByTestId('pods-table');
        await waitFor(() =>
            expect(
                within(table)
                    .getAllByRole('columnheader')
                    .map((header) => header.textContent),
            ).not.toContain('Restarts'),
        );
    });
});
