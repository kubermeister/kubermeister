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

const toasts = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', async () => ({
    ...(await vi.importActual<typeof import('sonner')>('sonner')),
    toast: toasts,
}));

const { ManifestPanel, spliceResourceVersion } = await import('@/components/templates/manifest-panel');
const { DeleteResourceButton } = await import('@/components/templates/delete-resource-button');
const { ScaleControl } = await import('@/components/templates/scale-control');
const { RestartButton } = await import('@/components/templates/restart-button');
const { RollbackButton } = await import('@/components/deployment/rollback-button');
const { PauseButton } = await import('@/components/deployment/pause-button');
const { IpcError } = await import('@/lib/ipc');
const { routeTree } = await import('@/routeTree.gen');

const YAML = [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: app-config',
    '  resourceVersion: "42"',
    '',
].join('\n');
const configMap = {
    name: 'app-config',
    namespace: 'team-a',
    keys: 1,
    size: '23 B',
    age: '1h',
    labels: [],
    annotations: [],
};
const otherMap = { ...configMap, name: 'other-config' };
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
    'resources.replace': { kind: 'ConfigMap', name: 'app-config', namespace: 'team-a' },
    'resources.delete': { kind: 'ConfigMap', name: 'app-config', namespace: 'team-a' },
    'resources.scale': { kind: 'Deployment', name: 'web', namespace: 'team-a' },
    'resources.restart': { kind: 'Deployment', name: 'web', namespace: 'team-a' },
    'deployments.rollback': { kind: 'Deployment', name: 'web', namespace: 'team-a', revision: '1', skipped: false },
    'deployments.pause': { kind: 'Deployment', name: 'web', namespace: 'team-a' },
    'resources.create': { kind: 'ConfigMap', name: 'my-config', namespace: 'team-a' },
};

beforeEach(() => {
    invoke.mockReset();
    toasts.success.mockReset();
    toasts.error.mockReset();
    invoke.mockImplementation(async (channel: string, input: { kind?: string }) => {
        if (channel === 'resources.get') return { kind: input.kind, item: configMap };
        if (channel === 'resources.list') return { kind: input.kind, items: [configMap, otherMap] };
        return data[channel];
    });
});

describe('spliceResourceVersion', () => {
    it('re-stamps the buffer with the version of a fresh read, keeping the edits', () => {
        const buffer = 'metadata:\n  resourceVersion: "42"\ndata:\n  a: edited\n';
        const fresh = 'metadata:\n  resourceVersion: "99"\ndata:\n  a: b\n';
        expect(spliceResourceVersion(buffer, fresh)).toContain('resourceVersion: "99"');
        expect(spliceResourceVersion(buffer, fresh)).toContain('a: edited');
    });

    it('reports that it cannot when either side has no version line', () => {
        expect(spliceResourceVersion('data: {}', 'metadata:\n  resourceVersion: "1"')).toBeNull();
        expect(spliceResourceVersion('metadata:\n  resourceVersion: "1"', 'data: {}')).toBeNull();
    });
});

describe('manifest editing', () => {
    it('saves the edited manifest in one press and returns to reading', async () => {
        renderInRouter(<ManifestPanel kind="ConfigMap" name="app-config" namespace="team-a" />);
        await screen.findByTestId('manifest-panel');
        await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
        // Nothing stands between the button and the write: the review is the other button's.
        expect(screen.queryByTestId('manifest-review')).not.toBeInTheDocument();
        // The write names the context the screen is on and the object the editor was opened for.
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('resources.replace', {
                context: 'alpha',
                manifest: YAML,
                expect: { kind: 'ConfigMap', name: 'app-config', namespace: 'team-a' },
            }),
        );
        expect(toasts.success).toHaveBeenCalledWith('ConfigMap “app-config” updated');
        expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
    });

    it('saves from the review with the same pin the editor would have used', async () => {
        renderInRouter(<ManifestPanel kind="ConfigMap" name="app-config" namespace="team-a" />);
        await screen.findByTestId('manifest-panel');
        await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Review changes' }));
        const review = await screen.findByTestId('manifest-review');
        await userEvent.click(within(review).getByRole('button', { name: 'Save' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('resources.replace', {
                context: 'alpha',
                manifest: YAML,
                expect: { kind: 'ConfigMap', name: 'app-config', namespace: 'team-a' },
            }),
        );
        expect(toasts.success).toHaveBeenCalledWith('ConfigMap “app-config” updated');
        expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
    });

    it('checks a manifest without writing it on a dry run', async () => {
        renderInRouter(<ManifestPanel kind="ConfigMap" name="app-config" namespace="team-a" />);
        await screen.findByTestId('manifest-panel');
        await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Dry run' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('resources.replace', {
                context: 'alpha',
                manifest: YAML,
                dryRun: true,
                expect: { kind: 'ConfigMap', name: 'app-config', namespace: 'team-a' },
            }),
        );
        expect(toasts.success).toHaveBeenCalledWith('Dry run passed', expect.anything());
    });

    it('shows what a save would change before it writes anything', async () => {
        renderInRouter(<ManifestPanel kind="ConfigMap" name="app-config" namespace="team-a" />);
        await screen.findByTestId('manifest-panel');
        await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Review changes' }));
        const review = await screen.findByTestId('manifest-review');
        expect(review).toHaveTextContent('Save changes to ConfigMap “app-config”?');
        expect(invoke).not.toHaveBeenCalledWith('resources.replace', expect.anything());

        // Keeping the edits open writes nothing at all.
        await userEvent.click(within(review).getByRole('button', { name: 'Keep editing' }));
        await waitFor(() => expect(screen.queryByTestId('manifest-review')).not.toBeInTheDocument());
        expect(invoke).not.toHaveBeenCalledWith('resources.replace', expect.anything());
        expect(await screen.findByRole('button', { name: 'Review changes' })).toBeInTheDocument();
    });

    it('offers to reload when the object changed under the edit', async () => {
        renderInRouter(<ManifestPanel kind="ConfigMap" name="app-config" namespace="team-a" />);
        await screen.findByTestId('manifest-panel');
        await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'resources.replace') {
                throw new IpcError({ kind: 'conflict', detail: 'changed', op: 'resources.replace' });
            }
            return data[channel];
        });
        await userEvent.click(await screen.findByRole('button', { name: 'Review changes' }));
        const review = await screen.findByTestId('manifest-review');
        await userEvent.click(within(review).getByRole('button', { name: 'Save' }));
        // The review closes on a rejection, so the banner it explains is the one on screen.
        await waitFor(() => expect(screen.queryByTestId('manifest-review')).not.toBeInTheDocument());
        const banner = await screen.findByTestId('manifest-conflict');
        expect(banner).toHaveTextContent('changed on the server');

        invoke.mockImplementation(async (channel: string) =>
            channel === 'resources.getYaml'
                ? { yaml: YAML.replace('"42"', '"99"'), kind: 'ConfigMap', namespace: 'team-a' }
                : data[channel],
        );
        await userEvent.click(within(banner).getByRole('button', { name: 'Reload latest' }));
        await waitFor(() => expect(screen.queryByTestId('manifest-conflict')).not.toBeInTheDocument());
    });

    it('arms the same banner when a save made without a review is rejected', async () => {
        renderInRouter(<ManifestPanel kind="ConfigMap" name="app-config" namespace="team-a" />);
        await screen.findByTestId('manifest-panel');
        await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'resources.replace') {
                throw new IpcError({ kind: 'conflict', detail: 'changed', op: 'resources.replace' });
            }
            return data[channel];
        });
        await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
        expect(await screen.findByTestId('manifest-conflict')).toHaveTextContent('changed on the server');
        // A rejected save leaves the editor open with the buffer in it.
        expect(screen.getByRole('button', { name: 'Review changes' })).toBeInTheDocument();
    });
});

describe('delete action', () => {
    it('names the object and its namespace before deleting it', async () => {
        renderInRouter(
            <DeleteResourceButton
                kind="ConfigMap"
                name="app-config"
                namespace="team-a"
                backTo="/workloads/configmaps"
            />,
        );
        await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('Delete ConfigMap?');
        expect(dialog).toHaveTextContent('from namespace team-a');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('resources.delete', {
                context: 'alpha',
                kind: 'ConfigMap',
                name: 'app-config',
                namespace: 'team-a',
            }),
        );
        expect(toasts.success).toHaveBeenCalledWith('ConfigMap “app-config” deleted');
    });

    it('asks for the name of a far-reaching kind before its delete is armed', async () => {
        invoke.mockImplementation(async (channel: string) =>
            channel === 'resources.delete' ? { kind: 'Node', name: 'node-1' } : data[channel],
        );
        renderInRouter(<DeleteResourceButton kind="Node" name="node-1" backTo="/overview/nodes" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('Every pod scheduled on it is lost.');
        const confirm = within(dialog).getByRole('button', { name: 'Delete' });
        expect(confirm).toBeDisabled();
        await userEvent.type(within(dialog).getByLabelText(/Type .* to confirm/), 'node-2');
        expect(confirm).toBeDisabled();
        await userEvent.clear(within(dialog).getByLabelText(/Type .* to confirm/));
        await userEvent.type(within(dialog).getByLabelText(/Type .* to confirm/), 'node-1');
        expect(confirm).toBeEnabled();
        await userEvent.click(confirm);
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('resources.delete', { context: 'alpha', kind: 'Node', name: 'node-1' }),
        );
    });

    it('refuses to write when no context is active', async () => {
        invoke.mockImplementation(async (channel: string) => (channel === 'context.current' ? null : data[channel]));
        renderInRouter(
            <DeleteResourceButton
                kind="ConfigMap"
                name="app-config"
                namespace="team-a"
                backTo="/workloads/configmaps"
            />,
        );
        await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
        await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
        // The write is refused before it reaches the bridge; the dialog closes on the failure.
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
        expect(invoke).toHaveBeenCalledWith('context.current', {});
        expect(invoke).not.toHaveBeenCalledWith('resources.delete', expect.anything());
        expect(toasts.success).not.toHaveBeenCalled();
    });

    it('can be dismissed without deleting anything', async () => {
        renderInRouter(<DeleteResourceButton kind="ClusterRole" name="reader" backTo="/access/clusterroles" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
        const dialog = await screen.findByRole('alertdialog');
        // A cluster-scoped object names no namespace.
        expect(dialog).not.toHaveTextContent('from namespace');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(invoke).not.toHaveBeenCalledWith('resources.delete', expect.anything());
    });
});

describe('scale control', () => {
    it('steps to an absolute target rather than a delta', async () => {
        renderInRouter(<ScaleControl kind="Deployment" name="web" namespace="team-a" replicas={2} />);
        await userEvent.click(await screen.findByRole('button', { name: 'Scale up' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('resources.scale', {
                context: 'alpha',
                kind: 'Deployment',
                name: 'web',
                namespace: 'team-a',
                replicas: 3,
            }),
        );
        expect(toasts.success).toHaveBeenCalledWith('Scaled Deployment “web” to 3');
    });

    it('cannot scale below zero', async () => {
        renderInRouter(<ScaleControl kind="Deployment" name="web" namespace="team-a" replicas={0} />);
        expect(await screen.findByRole('button', { name: 'Scale down' })).toHaveAttribute('aria-disabled', 'true');
    });

    it('takes an exact count from the popover', async () => {
        renderInRouter(<ScaleControl kind="StatefulSet" name="db" namespace="team-a" replicas={1} />);
        await userEvent.click(await screen.findByRole('button', { name: /currently 1 replicas/ }));
        const field = await screen.findByLabelText('Replicas');
        await userEvent.clear(field);
        await userEvent.type(field, '5');
        await userEvent.click(screen.getByRole('button', { name: 'Scale' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('resources.scale', {
                context: 'alpha',
                kind: 'StatefulSet',
                name: 'db',
                namespace: 'team-a',
                replicas: 5,
            }),
        );
    });
});

describe('restart action', () => {
    it('says what the rollout will do before stamping the workload', async () => {
        renderInRouter(<RestartButton kind="Deployment" name="web" namespace="team-a" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Restart' }));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('Restart Deployment?');
        expect(dialog).toHaveTextContent('replaced gradually');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Restart' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('resources.restart', {
                context: 'alpha',
                kind: 'Deployment',
                name: 'web',
                namespace: 'team-a',
            }),
        );
        expect(toasts.success).toHaveBeenCalledWith('Deployment “web” restarting', expect.anything());
    });

    it('describes the ordering each kind rolls its pods in', async () => {
        renderInRouter(<RestartButton kind="StatefulSet" name="db" namespace="team-a" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Restart' }));
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('one at a time, in reverse ordinal order');
    });

    it('can be dismissed without restarting anything', async () => {
        renderInRouter(<RestartButton kind="DaemonSet" name="agent" namespace="team-a" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Restart' }));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('pod on each node is replaced');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(invoke).not.toHaveBeenCalledWith('resources.restart', expect.anything());
    });

    it('keeps the dialog for a restart the cluster refused, without claiming it happened', async () => {
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'resources.restart') {
                throw new IpcError({ kind: 'forbidden', detail: 'no access', op: 'resources.restart' });
            }
            return data[channel];
        });
        renderInRouter(<RestartButton kind="Deployment" name="web" namespace="team-a" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Restart' }));
        await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restart' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('resources.restart', expect.anything()));
        expect(toasts.success).not.toHaveBeenCalled();
    });
});

describe('rollout control', () => {
    it('says what a rollback restores, and that it lands as a new revision', async () => {
        renderInRouter(<RollbackButton name="web" namespace="team-a" revision="1" image="nginx:1.21" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Roll back' }));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('Roll back to revision #1?');
        expect(dialog).toHaveTextContent('nginx:1.21');
        expect(dialog).toHaveTextContent('records this as a new revision');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('deployments.rollback', {
                context: 'alpha',
                name: 'web',
                namespace: 'team-a',
                revision: '1',
            }),
        );
        expect(toasts.success).toHaveBeenCalledWith('Rolled “web” back to revision #1', expect.anything());
    });

    it('reports a revision that is already running as a no-op rather than a rollback', async () => {
        invoke.mockImplementation(async (channel: string) =>
            channel === 'deployments.rollback'
                ? { kind: 'Deployment', name: 'web', namespace: 'team-a', revision: '2', skipped: true }
                : data[channel],
        );
        renderInRouter(<RollbackButton name="web" namespace="team-a" revision="2" image="nginx:1.27" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Roll back' }));
        await userEvent.click(
            within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Roll back' }),
        );
        await waitFor(() =>
            expect(toasts.success).toHaveBeenCalledWith('Revision #2 is already running', {
                description: 'Nothing was changed.',
            }),
        );
    });

    it('says nothing succeeded when the cluster refuses a rollback or a pause', async () => {
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'deployments.rollback' || channel === 'deployments.pause') {
                throw new IpcError({ kind: 'forbidden', detail: 'no access', op: channel });
            }
            return data[channel];
        });
        renderInRouter(<RollbackButton name="web" namespace="team-a" revision="1" image="nginx:1.21" />);
        await userEvent.click(await screen.findByRole('button', { name: 'Roll back' }));
        await userEvent.click(
            within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Roll back' }),
        );
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('deployments.rollback', expect.anything()));

        renderInRouter(<PauseButton name="web" namespace="team-a" paused={false} />);
        await userEvent.click(await screen.findByRole('button', { name: 'Pause' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('deployments.pause', expect.anything()));
        expect(toasts.success).not.toHaveBeenCalled();
    });

    it('holds a rollout and lets it go again from the same control', async () => {
        const { unmount } = renderInRouter(<PauseButton name="web" namespace="team-a" paused={false} />);
        await userEvent.click(await screen.findByRole('button', { name: 'Pause' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('deployments.pause', {
                context: 'alpha',
                name: 'web',
                namespace: 'team-a',
                paused: true,
            }),
        );
        expect(toasts.success).toHaveBeenCalledWith('Rollout of “web” paused', expect.anything());
        unmount();

        renderInRouter(<PauseButton name="web" namespace="team-a" paused />);
        await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('deployments.pause', expect.objectContaining({ paused: false })),
        );
        expect(toasts.success).toHaveBeenCalledWith('Rollout of “web” resumed', undefined);
    });
});

describe('create screen', () => {
    it('inserts a template, checks it and creates the object', async () => {
        renderRoutes(routeTree, '/create');
        const page = await screen.findByTestId('create-page');
        await waitFor(() => expect(page).toHaveTextContent('alpha / team-a'));
        await userEvent.click(within(page).getByRole('combobox', { name: 'Insert template' }));
        await userEvent.click(await screen.findByRole('option', { name: /ConfigMap/ }));
        await waitFor(() => expect(page.textContent).toContain('kind: ConfigMap'));

        await userEvent.click(within(page).getByRole('button', { name: 'Create' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('resources.create', {
                context: 'alpha',
                manifest: expect.any(String),
            }),
        );
        expect(toasts.success).toHaveBeenCalledWith('ConfigMap “my-config” created', {
            description: 'in namespace team-a',
        });
    });

    it('says that each manifest must name its namespace when none is selected', async () => {
        invoke.mockImplementation(async (channel: string) =>
            channel === 'namespace.active' ? { name: null } : data[channel],
        );
        renderRoutes(routeTree, '/create');
        const page = await screen.findByTestId('create-page');
        await waitFor(() => expect(page).toHaveTextContent('alpha / the namespace each manifest names'));
    });

    it('warns before a template would discard an edited manifest', async () => {
        renderRoutes(routeTree, '/create');
        const page = await screen.findByTestId('create-page');
        await userEvent.click(within(page).getByRole('combobox', { name: 'Insert template' }));
        // Anchored: an option is named for its kind and api version, so /Service/ also finds ServiceAccount.
        await userEvent.click(await screen.findByRole('option', { name: /^Service / }));
        await waitFor(() => expect(page.textContent).toContain('kind: Service'));

        // An untouched template is replaced without a warning.
        await userEvent.click(within(page).getByRole('combobox', { name: 'Insert template' }));
        await userEvent.click(await screen.findByRole('option', { name: /Secret/ }));
        await waitFor(() => expect(page.textContent).toContain('kind: Secret'));
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
});

describe('bulk delete', () => {
    it('deletes the checked rows and reports how many went', async () => {
        renderRoutes(routeTree, '/workloads/configmaps');
        const table = await screen.findByTestId('configmaps-table');
        await userEvent.click(within(table).getByRole('checkbox', { name: 'Select all rows on this page' }));
        const bar = await screen.findByTestId('bulk-delete-bar');
        expect(bar).toHaveTextContent('2 selected');

        await userEvent.click(within(bar).getByRole('button', { name: 'Delete 2' }));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('app-config, other-config');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Delete 2' }));
        await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('2 Config Maps deleted'));
        expect(invoke).toHaveBeenCalledWith('resources.delete', {
            context: 'alpha',
            kind: 'ConfigMap',
            name: 'other-config',
            namespace: 'team-a',
        });
    });

    it('keeps what failed selected and says why', async () => {
        invoke.mockImplementation(async (channel: string, input: { kind?: string; name?: string }) => {
            if (channel === 'resources.list') return { kind: input.kind, items: [configMap, otherMap] };
            if (channel === 'resources.delete' && input.name === 'other-config') {
                throw new IpcError({ kind: 'forbidden', detail: 'no access', op: 'resources.delete' });
            }
            if (channel === 'resources.delete') return data[channel];
            return data[channel];
        });
        renderRoutes(routeTree, '/workloads/configmaps');
        const table = await screen.findByTestId('configmaps-table');
        await userEvent.click(within(table).getByRole('checkbox', { name: 'Select all rows on this page' }));
        const bar = await screen.findByTestId('bulk-delete-bar');
        await userEvent.click(within(bar).getByRole('button', { name: 'Delete 2' }));
        await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete 2' }));
        await waitFor(() =>
            expect(toasts.error).toHaveBeenCalledWith('1 ConfigMap deleted, 1 failed', {
                description: 'team-a/other-config: no access',
            }),
        );
        // Only the row that failed stays checked, ready for a retry.
        expect(await screen.findByTestId('bulk-delete-bar')).toHaveTextContent('1 selected');
    });

    it('clears a selection without deleting anything', async () => {
        renderRoutes(routeTree, '/workloads/configmaps');
        const table = await screen.findByTestId('configmaps-table');
        await userEvent.click(within(table).getByRole('checkbox', { name: 'Select all rows on this page' }));
        await userEvent.click(
            within(await screen.findByTestId('bulk-delete-bar')).getByRole('button', { name: 'Clear' }),
        );
        await waitFor(() => expect(screen.queryByTestId('bulk-delete-bar')).not.toBeInTheDocument());
        expect(invoke).not.toHaveBeenCalledWith('resources.delete', expect.anything());
    });
});
