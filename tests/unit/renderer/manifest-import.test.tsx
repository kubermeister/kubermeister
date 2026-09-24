import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoutes } from './helpers';

const invoke = vi.fn();
const subscribe = vi.fn(() => () => {});
const stream = vi.fn(() => ({ stop: vi.fn(), send: vi.fn() }));
const importDroppedFile = vi.fn();
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    subscribe,
    stream,
    importDroppedFile,
}));

const toasts = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', async () => ({
    ...(await vi.importActual<typeof import('sonner')>('sonner')),
    toast: toasts,
}));

const { IpcError } = await import('@/lib/ipc');
const { clearStagedManifest } = await import('@/lib/manifest-import');
const { routeTree } = await import('@/routeTree.gen');

const YAML = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: from-disk\n';
const imported = { path: '/home/u/manifests/config.yaml', name: 'config.yaml', text: YAML };

const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
    'context.current': { name: 'alpha', cluster: 'a', user: 'u', current: true },
    'namespaces.list': [{ name: 'team-a', tone: 'accent' }],
    'namespace.active': { name: 'team-a' },
    'cluster.active': null,
    'metrics.alerts': [],
    'manifest.pick': imported,
};

/** A drop of one file on the window, as the browser delivers it: the File itself, never a path. */
function dropFile(file: File): void {
    const dataTransfer = { files: [file], items: [{ kind: 'file', type: file.type }], types: ['Files'] };
    fireEvent.dragEnter(window, { dataTransfer });
    fireEvent.dragOver(window, { dataTransfer });
    fireEvent.drop(window, { dataTransfer });
}

beforeEach(() => {
    invoke.mockReset();
    importDroppedFile.mockReset();
    toasts.success.mockReset();
    toasts.error.mockReset();
    clearStagedManifest();
    invoke.mockImplementation(async (channel: string, input: { kind?: string }) => {
        if (channel === 'resources.get') return { kind: input.kind, item: null };
        if (channel === 'resources.list') return { kind: input.kind, items: [] };
        return data[channel];
    });
    importDroppedFile.mockResolvedValue(imported);
});

describe('importing a manifest through the OS picker', () => {
    it('opens the file main read and names it, without reading it in the renderer', async () => {
        renderRoutes(routeTree, '/create');
        const page = await screen.findByTestId('create-page');
        await userEvent.click(within(page).getByRole('button', { name: 'Import' }));
        await waitFor(() => expect(page.textContent).toContain('name: from-disk'));
        expect(invoke).toHaveBeenCalledWith('manifest.pick', {});
        expect(page).toHaveTextContent('config.yaml');
    });

    it('checks the manifest it opened against the schema of the kind it names', async () => {
        renderRoutes(routeTree, '/create');
        const page = await screen.findByTestId('create-page');
        await userEvent.click(within(page).getByRole('button', { name: 'Import' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('schemas.forKind', { apiVersion: 'v1', kind: 'ConfigMap' }),
        );
    });

    it('leaves the editor alone when the picker is cancelled', async () => {
        invoke.mockImplementation(async (channel: string) => (channel === 'manifest.pick' ? null : data[channel]));
        renderRoutes(routeTree, '/create');
        const page = await screen.findByTestId('create-page');
        await userEvent.click(within(page).getByRole('button', { name: 'Import' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('manifest.pick', {}));
        expect(page.textContent).not.toContain('from-disk');
        expect(toasts.error).not.toHaveBeenCalled();
    });

    it('says why a file could not be read', async () => {
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'manifest.pick') {
                throw new IpcError({ kind: 'invalid', detail: 'image.yaml is not text.', op: 'manifest.pick' });
            }
            return data[channel];
        });
        renderRoutes(routeTree, '/create');
        const page = await screen.findByTestId('create-page');
        await userEvent.click(within(page).getByRole('button', { name: 'Import' }));
        await waitFor(() =>
            expect(toasts.error).toHaveBeenCalledWith(
                'Could not import that file',
                expect.objectContaining({ description: expect.stringContaining('not text') }),
            ),
        );
    });
});

describe('importing a manifest by dropping it on the window', () => {
    it('opens a file dropped on any screen in the create editor', async () => {
        const { router } = renderRoutes(routeTree, '/cluster/nodes');
        await screen.findByTestId('app-shell');
        dropFile(new File([YAML], 'config.yaml', { type: 'application/yaml' }));

        const page = await screen.findByTestId('create-page');
        await waitFor(() => expect(page.textContent).toContain('name: from-disk'));
        expect(router.state.location.pathname).toBe('/create');
        // The renderer hands the File over and gets text back; it never learns the path itself.
        expect(importDroppedFile).toHaveBeenCalledWith(expect.any(File));
    });

    it('marks the window as a drop target only while a file is over it', async () => {
        renderRoutes(routeTree, '/create');
        await screen.findByTestId('app-shell');
        const dataTransfer = { files: [], items: [{ kind: 'file', type: '' }], types: ['Files'] };
        fireEvent.dragEnter(window, { dataTransfer });
        expect(await screen.findByTestId('manifest-drop-target')).toBeInTheDocument();
        fireEvent.dragLeave(window, { dataTransfer });
        await waitFor(() => expect(screen.queryByTestId('manifest-drop-target')).not.toBeInTheDocument());
    });

    it('ignores a drag that carries no file', async () => {
        renderRoutes(routeTree, '/cluster/nodes');
        await screen.findByTestId('app-shell');
        const dataTransfer = { files: [], items: [], types: ['text/plain'] };
        fireEvent.dragEnter(window, { dataTransfer });
        fireEvent.dragOver(window, { dataTransfer });
        fireEvent.dragLeave(window, { dataTransfer });
        expect(screen.queryByTestId('manifest-drop-target')).not.toBeInTheDocument();
        fireEvent.drop(window, { dataTransfer });
        expect(importDroppedFile).not.toHaveBeenCalled();
    });

    it('lets go of a file drag that arrives carrying nothing to read', async () => {
        renderRoutes(routeTree, '/cluster/nodes');
        await screen.findByTestId('app-shell');
        const dataTransfer = { files: [], items: [{ kind: 'file', type: '' }], types: ['Files'] };
        fireEvent.dragEnter(window, { dataTransfer });
        expect(await screen.findByTestId('manifest-drop-target')).toBeInTheDocument();
        fireEvent.drop(window, { dataTransfer });
        await waitFor(() => expect(screen.queryByTestId('manifest-drop-target')).not.toBeInTheDocument());
        expect(importDroppedFile).not.toHaveBeenCalled();
    });

    it('reports a dropped file that main would not read', async () => {
        importDroppedFile.mockRejectedValue(
            new IpcError({ kind: 'invalid', detail: 'manifests is not a file.', op: 'manifest.read' }),
        );
        renderRoutes(routeTree, '/cluster/nodes');
        await screen.findByTestId('app-shell');
        dropFile(new File([''], 'manifests'));
        await waitFor(() =>
            expect(toasts.error).toHaveBeenCalledWith(
                'Could not import that file',
                expect.objectContaining({ description: expect.stringContaining('not a file') }),
            ),
        );
    });

    it('lets the editor alone read a file dropped onto it, which main has already read', async () => {
        renderRoutes(routeTree, '/create');
        const page = await screen.findByTestId('create-page');
        const editor = within(page).getByRole('textbox', { name: 'YAML manifest' });
        const file = new File([YAML], 'config.yaml');
        const dataTransfer = { files: [file], items: [{ kind: 'file', type: '' }], types: ['Files'] };
        const readAsText = vi.spyOn(FileReader.prototype, 'readAsText');
        fireEvent.drop(editor, { dataTransfer });

        await waitFor(() => expect(page.textContent).toContain('name: from-disk'));
        expect(importDroppedFile).toHaveBeenCalledOnce();
        // CodeMirror answers a file drop by reading it in the renderer and pasting it where it
        // landed. Nothing here reads a file but main.
        expect(readAsText).not.toHaveBeenCalled();
    });

    it('warns before a dropped file would discard an edited manifest', async () => {
        renderRoutes(routeTree, '/create');
        const page = await screen.findByTestId('create-page');
        await userEvent.click(within(page).getByRole('combobox', { name: 'Insert template' }));
        await userEvent.click(await screen.findByRole('option', { name: /^Service / }));
        await waitFor(() => expect(page.textContent).toContain('kind: Service'));
        await userEvent.click(within(page).getByRole('textbox', { name: 'YAML manifest' }));
        await userEvent.keyboard('# edited');

        dropFile(new File([YAML], 'config.yaml'));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('config.yaml');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
        expect(page.textContent).not.toContain('from-disk');

        dropFile(new File([YAML], 'config.yaml'));
        await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Replace' }));
        await waitFor(() => expect(page.textContent).toContain('name: from-disk'));
    });
});

describe('importDroppedFile', () => {
    it('unwraps the envelope the preload answers with', async () => {
        const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
        const file = new File([YAML], 'config.yaml');
        window.km = {
            ...window.km,
            importFile: vi.fn().mockResolvedValue({ ok: true, data: imported }),
        };
        await expect(actual.importDroppedFile(file)).resolves.toEqual(imported);
        expect(window.km.importFile).toHaveBeenCalledWith(file);
    });

    it('rethrows a classified failure with its structure intact', async () => {
        const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
        window.km = {
            ...window.km,
            importFile: vi
                .fn()
                .mockResolvedValue({ ok: false, error: { kind: 'notFound', detail: 'gone', op: 'manifest.read' } }),
        };
        await expect(actual.importDroppedFile(new File([''], 'x'))).rejects.toMatchObject({
            kind: 'notFound',
            detail: 'gone',
        });
    });
});
