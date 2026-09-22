import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type { ManifestFile } from '../../shared/manifest-file';
import { importDroppedFile } from './ipc';
import { describeError } from './k8s-error';

/**
 * A manifest read from disk, waiting for the Create screen to pick it up. It is held outside React
 * because a file can be dropped on any screen: the drop is handled by the shell, which stages the
 * text here and navigates, and the editor may not exist yet when it does. `seq` is what makes a
 * second drop of the same file a second import.
 */
export interface StagedManifest extends ManifestFile {
    seq: number;
}

let staged: StagedManifest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function publish(): void {
    for (const listener of listeners) listener();
}

export function stageManifestImport(file: ManifestFile): void {
    staged = { ...file, seq: ++seq };
    publish();
}

/** Called once the editor has taken the import, so returning to the screen does not load it again. */
export function clearStagedManifest(): void {
    if (!staged) return;
    staged = null;
    publish();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useStagedManifest(): StagedManifest | null {
    return useSyncExternalStore(subscribe, () => staged);
}

/** Whether a drag carries files, as opposed to selected text or a link from another window. */
function carriesFiles(transfer: DataTransfer | null): transfer is DataTransfer {
    return !!transfer && Array.from(transfer.types).includes('Files');
}

export function importFailed(error: unknown): void {
    toast.error('Could not import that file', { description: describeError(error).detail });
}

/**
 * Accept a manifest dropped anywhere on the window. The listeners are on the window rather than on
 * a drop zone because there is no one place to aim at: the file is meant for the Create screen,
 * which is usually not the screen being looked at. Only the `File` object crosses into the bridge —
 * the preload turns it into a path and main does the reading.
 */
export function useManifestDrop(onImported: (file: ManifestFile) => void): { dragging: boolean } {
    const [dragging, setDragging] = useState(false);
    // The shell passes a fresh closure on every render; keeping it in a ref means the listeners are
    // attached once instead of being torn down and rebuilt mid-drag.
    const imported = useRef(onImported);
    useEffect(() => {
        imported.current = onImported;
    }, [onImported]);

    useEffect(() => {
        // Dragging over a child fires `dragleave` for the parent, so the overlay follows a depth
        // count rather than the last event, or it would flicker across every element crossed.
        let depth = 0;
        const enter = (event: DragEvent) => {
            if (!carriesFiles(event.dataTransfer)) return;
            depth += 1;
            setDragging(true);
        };
        const leave = (event: DragEvent) => {
            if (!carriesFiles(event.dataTransfer)) return;
            depth = Math.max(0, depth - 1);
            if (depth === 0) setDragging(false);
        };
        const over = (event: DragEvent) => {
            if (!carriesFiles(event.dataTransfer)) return;
            // Without this the drop event never fires and Chromium opens the file instead.
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        };
        const drop = (event: DragEvent) => {
            if (!carriesFiles(event.dataTransfer)) return;
            event.preventDefault();
            depth = 0;
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (!file) return;
            importDroppedFile(file).then((manifest) => imported.current(manifest), importFailed);
        };
        window.addEventListener('dragenter', enter);
        window.addEventListener('dragleave', leave);
        window.addEventListener('dragover', over);
        window.addEventListener('drop', drop);
        return () => {
            window.removeEventListener('dragenter', enter);
            window.removeEventListener('dragleave', leave);
            window.removeEventListener('dragover', over);
            window.removeEventListener('drop', drop);
        };
    }, []);

    return { dragging };
}
