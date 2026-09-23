import type { QueryClient } from '@tanstack/react-query';
import type { Settings, SettingsInput } from '../../shared/settings';
import { invoke, subscribe } from './ipc';
import { invalidateClusterQueries, ipcQueryKey, useIpcQuery } from './query';

const SETTINGS_KEY = ipcQueryKey('settings.get', {});
const STARTUP_KEY = ipcQueryKey('startupChecks', {});
const FILE_KEY = ipcQueryKey('settingsFile.status', {});

export function useSettings() {
    return useIpcQuery('settings.get', {});
}

/** Where the settings file is and what is wrong with it. */
export function useSettingsFile() {
    return useIpcQuery('settingsFile.status', {});
}

/** Show the settings file in the file manager; main names the path, never the renderer. */
export async function revealSettingsFile(): Promise<void> {
    await invoke('settingsFile.reveal', {});
}

/** Live-poll cadence in milliseconds from the persisted refresh interval, falling back while settings load. */
export function useRefreshIntervalMs(fallbackMs = 12_000): number {
    const { data } = useSettings();
    return data ? data.data.refreshIntervalSec * 1000 : fallbackMs;
}

/** How many log lines a live follow keeps, from settings, falling back while they load. */
export function useLogBufferLines(fallback = 2_000): number {
    const { data } = useSettings();
    return data ? data.data.logBufferLines : fallback;
}

/** Terminal font size from settings, falling back while they load. */
export function useTerminalFontSize(fallback = 12): number {
    const { data } = useSettings();
    return data ? data.data.terminalFontSize : fallback;
}

/** Persist a patch; the merged result lands in the cache so controls reflect it at once. */
export async function updateSettings(client: QueryClient, patch: SettingsInput): Promise<Settings> {
    const settings = await invoke('settings.set', patch);
    client.setQueryData(SETTINGS_KEY, settings);
    // A save is what reveals a file that cannot be written, and what creates one that did not exist.
    await client.invalidateQueries({ queryKey: FILE_KEY });
    return settings;
}

/** Re-point the app at a kubeconfig through the native dialog; a cancelled dialog changes nothing. */
export async function pickKubeconfig(client: QueryClient): Promise<void> {
    const { path } = await invoke('kubeconfig.pick', {});
    if (path === null) return;
    await client.invalidateQueries({ queryKey: SETTINGS_KEY });
    await recheckConnection(client);
}

/**
 * Point the app at a bundle of extra certificate authorities, or stop trusting one. Both go through
 * main, which is where the file is chosen and where the connection is remade, and both reset the
 * cluster reads, since what they trust has changed.
 */
export async function pickCaBundle(client: QueryClient): Promise<void> {
    const { path } = await invoke('caBundle.pick', {});
    if (path === null) return;
    await client.invalidateQueries({ queryKey: SETTINGS_KEY });
    await recheckConnection(client);
}

export async function clearCaBundle(client: QueryClient): Promise<void> {
    const settings = await invoke('caBundle.clear', {});
    client.setQueryData(SETTINGS_KEY, settings);
    await recheckConnection(client);
}

export async function resetKubeconfig(client: QueryClient): Promise<void> {
    const settings = await invoke('kubeconfig.useDefault', {});
    client.setQueryData(SETTINGS_KEY, settings);
    await recheckConnection(client);
}

/**
 * Run the startup checks again and start every cluster read over. The checks are what the top-bar
 * connection notice reads, so a kubeconfig fixed on disk, picked or reset clears the notice here and
 * nowhere else; the reads then load under whatever the kubeconfig now says.
 */
export async function recheckConnection(client: QueryClient): Promise<void> {
    await client.invalidateQueries({ queryKey: STARTUP_KEY });
    await client.invalidateQueries({ queryKey: FILE_KEY });
    await invalidateClusterQueries();
}

/**
 * Follow edits made to the settings file outside the app: main has already taken the change in, so
 * every screen reading a setting refetches it, the file's problems and the startup report follow,
 * and when the connection was remade with it every cluster read starts over. Answers the function
 * that stops following.
 */
export function followSettingsFile(client: QueryClient): () => void {
    return subscribe('settings.changed', ({ reconnected }) => {
        void client.invalidateQueries({ queryKey: SETTINGS_KEY });
        void client.invalidateQueries({ queryKey: FILE_KEY });
        void client.invalidateQueries({ queryKey: STARTUP_KEY });
        if (reconnected) void invalidateClusterQueries();
    });
}
