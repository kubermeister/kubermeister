import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderInRouter, renderRoutes } from './helpers';

const invoke = vi.fn();
const subscribe = vi.fn(() => () => {});
const stream = vi.fn(() => ({ stop: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    subscribe,
    stream,
}));

const downloadTextFile = vi.fn();
vi.mock('@/lib/download', () => ({ downloadTextFile }));

const { ManifestPanel } = await import('@/components/templates/manifest-panel');
const { IpcError } = await import('@/lib/ipc');
const { routeTree } = await import('@/routeTree.gen');

const YAML = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app-config\n';
const configMap = {
    name: 'app-config',
    namespace: 'team-a',
    keys: 1,
    size: '23 B',
    age: '1h',
    labels: [],
    annotations: [],
};
const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'context.current': { name: 'alpha', cluster: 'a', user: 'u', current: true },
    'namespaces.list': [{ name: 'team-a', tone: 'accent' }],
    'namespace.active': { name: 'team-a' },
    'cluster.active': null,
    'events.forObject': [],
    'configMaps.entries': [],
    'resources.getYaml': { yaml: YAML, kind: 'ConfigMap', namespace: 'team-a' },
};

beforeEach(() => {
    invoke.mockReset();
    downloadTextFile.mockReset();
    invoke.mockImplementation(async (channel: string, input: { kind?: string }) => {
        if (channel === 'resources.get') return { kind: input.kind, item: configMap };
        if (channel === 'resources.list') return { kind: input.kind, items: [configMap] };
        return data[channel];
    });
});

describe('manifest panel', () => {
    it('shows the live yaml and asks for it by kind, name and namespace', async () => {
        renderInRouter(<ManifestPanel kind="ConfigMap" name="app-config" namespace="team-a" />);
        const panel = await screen.findByTestId('manifest-panel');
        expect(panel).toHaveTextContent('ConfigMap “app-config”');
        // CodeMirror renders the document into its own content element.
        await waitFor(() => expect(panel.textContent).toContain('kind: ConfigMap'));
        expect(invoke).toHaveBeenCalledWith('resources.getYaml', {
            kind: 'ConfigMap',
            name: 'app-config',
            namespace: 'team-a',
        });
    });

    it('checks the manifest against its schema only once it is being edited', async () => {
        renderInRouter(<ManifestPanel kind="ConfigMap" name="app-config" namespace="team-a" />);
        const panel = await screen.findByTestId('manifest-panel');
        await waitFor(() => expect(panel.textContent).toContain('kind: ConfigMap'));
        expect(invoke).not.toHaveBeenCalledWith('schemas.forKind', expect.anything());
        await userEvent.click(within(panel).getByRole('button', { name: 'Edit' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('schemas.forKind', { apiVersion: 'v1', kind: 'ConfigMap' }),
        );
    });

    it('offers the manifest as a download named after the object', async () => {
        renderInRouter(<ManifestPanel kind="ConfigMap" name="app-config" namespace="team-a" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Download' }));
        expect(downloadTextFile).toHaveBeenCalledWith('app-config.yaml', YAML, 'text/yaml');
    });

    it('labels the editor for assistive technology and keeps it read only', async () => {
        renderInRouter(<ManifestPanel kind="ConfigMap" name="app-config" namespace="team-a" />);
        const editor = await screen.findByLabelText('ConfigMap manifest');
        expect(editor).toHaveAttribute('contenteditable', 'false');
    });

    it('reports a failed read with its cause and retries on demand', async () => {
        invoke.mockRejectedValue(new IpcError({ kind: 'forbidden', detail: 'no access', op: 'resources.getYaml' }));
        renderInRouter(<ManifestPanel kind="ConfigMap" name="app-config" namespace="team-a" />);
        const panel = await screen.findByTestId('manifest-error');
        expect(panel).toHaveTextContent('Access denied: no access');

        invoke.mockResolvedValue({ yaml: YAML, kind: 'ConfigMap' });
        await userEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
        expect(await screen.findByTestId('manifest-panel')).toBeInTheDocument();
    });

    it('omits the namespace for a cluster-scoped kind', async () => {
        renderInRouter(<ManifestPanel kind="PersistentVolume" name="pv-1" />);
        await screen.findByTestId('manifest-panel');
        expect(invoke).toHaveBeenCalledWith('resources.getYaml', {
            kind: 'PersistentVolume',
            name: 'pv-1',
            namespace: undefined,
        });
    });
});

describe('manifest tab on a detail screen', () => {
    it('sits first under INSPECT and shows the object yaml', async () => {
        renderRoutes(routeTree, '/workloads/configmaps/team-a/app-config');
        const page = await screen.findByTestId('configmap-page');
        await waitFor(() => expect(page).toHaveTextContent('keys: 1'));
        const tabs = within(page).getAllByRole('tab');
        const inspect = tabs.map((tab) => tab.textContent ?? '');
        expect(inspect.indexOf('ManifestYAML')).toBeLessThan(inspect.findIndex((label) => label.startsWith('Labels')));

        await userEvent.click(within(page).getByRole('tab', { name: /Manifest/ }));
        await waitFor(() =>
            expect(within(page).getByTestId('manifest-panel').textContent).toContain('kind: ConfigMap'),
        );
    });
});
