import { BrowserWindow, dialog } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ManifestFile } from '../shared/manifest-file.js';
import { K8sError } from './k8s/errors.js';

/**
 * How much of a file the Create screen will take. A manifest is a document somebody wrote, so this
 * is generous by two orders of magnitude; what it is really for is the file that is not a manifest
 * at all — a disk image dragged onto the window would otherwise be read whole into memory and then
 * into an editor that has to lay every line of it out.
 */
export const MANIFEST_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Read a manifest from disk. Only main ever touches the file: the renderer sees the text, never a
 * file handle, and cannot name the path either — the picker's comes from the OS dialog and a
 * dropped file's is resolved in the preload by `webUtils.getPathForFile`, which answers only for a
 * file somebody really dragged in. `op` names which of the two asked, so a failure points at the
 * gesture the user made rather than at the channel underneath.
 */
export async function readManifestFile(path: string, op = 'manifest.read'): Promise<ManifestFile> {
    const name = basename(path);
    const info = await stat(path).catch(() => {
        throw new K8sError('notFound', `There is no file at ${path}.`, op);
    });
    if (!info.isFile()) throw new K8sError('invalid', `${name} is not a file.`, op);
    if (info.size > MANIFEST_FILE_BYTES) {
        throw new K8sError('invalid', `${name} is larger than ${MANIFEST_FILE_BYTES / (1024 * 1024)} MB.`, op);
    }
    const contents = await readFile(path).catch((error: unknown) => {
        throw new K8sError('unknown', `${name} could not be read: ${String(error)}`, op);
    });
    // A binary file decodes to replacement characters rather than failing, which would reach the
    // editor as a page of garbage and the cluster as a parse error nobody can act on.
    if (contents.includes(0)) throw new K8sError('invalid', `${name} is not text.`, op);
    return { path, name, text: contents.toString('utf8') };
}

/**
 * Choose a manifest through the OS file dialog. Null is a cancelled picker, which is not a failure
 * and leaves the editor as it was.
 */
export async function pickManifestFile(): Promise<ManifestFile | null> {
    const owner = BrowserWindow.getFocusedWindow() ?? undefined;
    const options: Electron.OpenDialogOptions = {
        title: 'Open a manifest',
        properties: ['openFile'],
        filters: [
            { name: 'Manifests', extensions: ['yaml', 'yml', 'json'] },
            { name: 'All files', extensions: ['*'] },
        ],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const path = result.canceled ? undefined : result.filePaths[0];
    if (!path) return null;
    return readManifestFile(path, 'manifest.pick');
}
