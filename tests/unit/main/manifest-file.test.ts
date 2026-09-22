import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dialog = { showOpenDialog: vi.fn() };
const focused = { id: 1 };
const getFocusedWindow = vi.fn<() => unknown>(() => focused);
vi.mock('electron', () => ({ dialog, BrowserWindow: { getFocusedWindow: () => getFocusedWindow() } }));

const { MANIFEST_FILE_BYTES, pickManifestFile, readManifestFile } = await import('../../../src/main/manifest-file.js');
const { K8sError } = await import('../../../src/main/k8s/errors.js');

const YAML = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app-config\n';

let dir = '';
const file = (name: string, contents: string | Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
};

/** The classified failure a read answered with, so a test can assert on its kind and sentence. */
async function failure(promise: Promise<unknown>): Promise<InstanceType<typeof K8sError>> {
    const error = await promise.then(
        () => null,
        (thrown: unknown) => thrown,
    );
    if (!(error instanceof K8sError)) throw new Error(`expected a K8sError, got ${String(error)}`);
    return error;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'km-manifest-file-'));
    vi.clearAllMocks();
    getFocusedWindow.mockReturnValue(focused);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readManifestFile', () => {
    it('answers the text of the file with the name it was saved under', async () => {
        const path = file('deployment.yaml', YAML);
        await expect(readManifestFile(path)).resolves.toEqual({ path, name: 'deployment.yaml', text: YAML });
    });

    it('reads a file the OS picker would never have offered, since a drop names any file', async () => {
        const path = file('manifest', YAML);
        await expect(readManifestFile(path)).resolves.toMatchObject({ name: 'manifest', text: YAML });
    });

    it('says so when there is no such file', async () => {
        const error = await failure(readManifestFile(join(dir, 'gone.yaml')));
        expect(error.kind).toBe('notFound');
        expect(error.detail).toContain('gone.yaml');
        expect(error.op).toBe('manifest.read');
    });

    it('refuses a directory rather than reading one', async () => {
        mkdirSync(join(dir, 'manifests'));
        const error = await failure(readManifestFile(join(dir, 'manifests')));
        expect(error.kind).toBe('invalid');
        expect(error.detail).toContain('not a file');
    });

    it('refuses a file larger than the cap instead of loading it into the editor', async () => {
        const path = file('huge.yaml', 'x'.repeat(MANIFEST_FILE_BYTES + 1));
        const error = await failure(readManifestFile(path));
        expect(error.kind).toBe('invalid');
        expect(error.detail).toContain('larger than');
    });

    it('reads a file right up to the cap', async () => {
        const path = file('big.yaml', 'x'.repeat(MANIFEST_FILE_BYTES));
        await expect(readManifestFile(path)).resolves.toMatchObject({ name: 'big.yaml' });
    });

    it('says when the file is there but cannot be read', async ({ skip }) => {
        // Root reads a file whatever its mode says, so there is nothing to observe there.
        skip(process.getuid?.() === 0, 'running as root');
        const path = file('locked.yaml', YAML);
        chmodSync(path, 0o000);
        const error = await failure(readManifestFile(path));
        expect(error.kind).toBe('unknown');
        expect(error.detail).toContain('locked.yaml');
    });

    it('refuses a file that is not text, rather than filling the editor with replacement characters', async () => {
        const path = file('image.yaml', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]));
        const error = await failure(readManifestFile(path));
        expect(error.kind).toBe('invalid');
        expect(error.detail).toContain('not text');
    });
});

describe('pickManifestFile', () => {
    it('reads the file the OS picker returned, over the focused window', async () => {
        const path = file('service.yaml', YAML);
        dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] });
        await expect(pickManifestFile()).resolves.toEqual({ path, name: 'service.yaml', text: YAML });
        expect(dialog.showOpenDialog).toHaveBeenCalledWith(
            focused,
            expect.objectContaining({ properties: ['openFile'] }),
        );
    });

    it('opens the dialog without an owner when no window has focus', async () => {
        getFocusedWindow.mockReturnValue(null);
        dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
        await expect(pickManifestFile()).resolves.toBeNull();
        expect(dialog.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Open a manifest' }));
    });

    it('answers nothing when the picker is cancelled', async () => {
        dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
        await expect(pickManifestFile()).resolves.toBeNull();
    });

    it('reports a picked file that cannot be read the same way a dropped one is', async () => {
        dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [join(dir, 'gone.yaml')] });
        const error = await failure(pickManifestFile());
        expect(error.kind).toBe('notFound');
        expect(error.op).toBe('manifest.pick');
    });
});
