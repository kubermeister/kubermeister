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

const volume = {
    name: 'pv-1',
    capacity: '10Gi',
    accessModes: 'RWO',
    reclaimPolicy: 'Delete',
    status: 'Bound',
    claim: 'team-a/data',
    storageClass: 'local-path',
    age: '1h',
};
const claim = {
    name: 'data',
    namespace: 'team-a',
    status: 'Pending',
    volume: '—',
    capacity: '1Gi',
    accessModes: 'RWO',
    storageClass: 'local-path',
    age: '1h',
};
const storageClass = {
    name: 'local-path',
    provisioner: 'rancher.io/local-path',
    reclaimPolicy: 'Delete',
    volumeBinding: 'WaitForFirstConsumer',
    isDefault: true,
    age: '1h',
};
const snapshot = {
    name: 'snap',
    namespace: 'team-a',
    sourcePvc: 'pvc/data',
    restoreSize: '10Gi',
    ready: 'Ready',
    age: '1h',
};
const meta = { labels: [['tier', 'db']], annotations: [] };
const rows: Record<string, unknown[]> = {
    PersistentVolume: [volume],
    PersistentVolumeClaim: [claim],
    StorageClass: [storageClass, { ...storageClass, name: 'slow', isDefault: false }],
    VolumeSnapshot: [snapshot],
};
const details: Record<string, unknown> = {
    PersistentVolume: { ...volume, ...meta },
    PersistentVolumeClaim: { ...claim, ...meta },
    StorageClass: { ...storageClass, ...meta },
    VolumeSnapshot: { ...snapshot, ...meta },
};
const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'context.current': { name: 'alpha', cluster: 'a', user: 'u', current: true },
    'namespaces.list': [{ name: 'team-a', tone: 'accent' }],
    'namespace.active': { name: 'team-a' },
    'cluster.active': null,
    'events.forObject': [],
};

beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (channel: string, input: { kind?: string }) => {
        if (channel === 'resources.list') return { kind: input.kind, items: rows[input.kind!] ?? [] };
        if (channel === 'resources.get') return { kind: input.kind, item: details[input.kind!] ?? null };
        return data[channel];
    });
});

describe('storage lists', () => {
    it('lists volumes with a toned phase and a link that carries no namespace', async () => {
        renderRoutes(routeTree, '/storage/volumes');
        const table = await screen.findByTestId('volumes-table');
        const row = table.querySelector('[data-volume="pv-1"]') as HTMLElement;
        expect(within(row).getByRole('link', { name: 'pv-1' })).toHaveAttribute('href', '/storage/volumes/pv-1');
        expect(within(row).getByText('Bound')).toHaveAttribute('data-tone', 'ok');
        expect(row).toHaveTextContent('team-a/data');
        expect(row).toHaveTextContent('RWO');
    });

    it('exports checked storage classes but offers no bulk delete, which would skip the typed name', async () => {
        renderRoutes(routeTree, '/storage/storageclasses');
        const classes = await screen.findByTestId('storageclasses-table');
        await userEvent.click(within(classes).getByRole('checkbox', { name: 'Select all rows on this page' }));
        const bar = await screen.findByTestId('selection-bar');
        expect(within(bar).getByRole('button', { name: /^Export 2/ })).toBeInTheDocument();
        expect(within(bar).queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
    });

    it('lists claims, storage classes with a default badge, and snapshots by polling', async () => {
        renderRoutes(routeTree, '/storage/claims');
        const claims = await screen.findByTestId('claims-table');
        expect(within(claims).getByText('Pending')).toHaveAttribute('data-tone', 'warn');

        await userEvent.click(screen.getByRole('link', { name: 'Storage Classes' }));
        const classes = await screen.findByTestId('storageclasses-table');
        expect(classes.querySelector('[data-storageclass="local-path"]')).toHaveTextContent('default');
        expect(classes.querySelector('[data-storageclass="slow"]')).toHaveTextContent('—');

        await userEvent.click(screen.getByRole('link', { name: 'Snapshots' }));
        const snapshots = await screen.findByTestId('snapshots-table');
        // The column header also reads Ready, so match the badge by its tone attribute.
        expect(within(snapshots).getByText('Ready', { selector: '[data-tone]' })).toHaveAttribute('data-tone', 'ok');
        expect(snapshots).toHaveTextContent('pvc/data');
        // Snapshots are polled, not watched: no watch stream is opened for them.
        expect(
            stream.mock.calls.filter(([, input]) => (input as { kind: string }).kind === 'VolumeSnapshot'),
        ).toHaveLength(0);
    });

    it('explains an empty snapshot list as a possibly missing CRD', async () => {
        invoke.mockImplementation(async (channel: string, input: { kind?: string }) =>
            channel === 'resources.list' ? { kind: input.kind, items: [] } : data[channel],
        );
        renderRoutes(routeTree, '/storage/snapshots');
        expect(await screen.findByText(/may not have the VolumeSnapshot CRD installed/)).toBeInTheDocument();
    });
});

describe('storage details', () => {
    it('shows the cluster-scoped volume and storage class details without a namespace', async () => {
        renderRoutes(routeTree, '/storage/volumes/pv-1');
        const page = await screen.findByTestId('volume-page');
        await waitFor(() => expect(page).toHaveTextContent('capacity: 10Gi'));
        expect(page).toHaveTextContent('claim: team-a/data');
        expect(within(page).getAllByText('Bound', { selector: '[data-tone]' })[0]).toHaveAttribute('data-tone', 'ok');
        expect(invoke).toHaveBeenCalledWith('resources.get', {
            kind: 'PersistentVolume',
            name: 'pv-1',
            namespace: undefined,
        });

        renderRoutes(routeTree, '/storage/storageclasses/local-path');
        const classPage = await screen.findByTestId('storageclass-page');
        await waitFor(() => expect(classPage).toHaveTextContent('provisioner: rancher.io/local-path'));
        expect(classPage).toHaveTextContent('Default class');
    });

    it('shows the claim and snapshot details and a not-found state naming the namespace', async () => {
        renderRoutes(routeTree, '/storage/claims/team-a/data');
        const claimPage = await screen.findByTestId('claim-page');
        await waitFor(() => expect(claimPage).toHaveTextContent('capacity: 1Gi'));

        const { router } = renderRoutes(routeTree, '/storage/snapshots/team-a/snap');
        const snapPage = await screen.findByTestId('snapshot-page');
        await waitFor(() => expect(snapPage).toHaveTextContent('source: pvc/data'));

        invoke.mockImplementation(async (channel: string, input: { kind?: string }) =>
            channel === 'resources.get' ? { kind: input.kind, item: null } : data[channel],
        );
        await router.navigate({
            to: '/storage/snapshots/$namespace/$name',
            params: { namespace: 'team-a', name: 'ghost' },
        });
        expect(await screen.findByTestId('not-found')).toHaveTextContent(
            'VolumeSnapshot “ghost” was not found in namespace “team-a”.',
        );
    });
});
