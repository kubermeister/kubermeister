import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_NAME, KUBECONFIG_PATH, NAMESPACE } from './cluster';

export interface LaunchedApp {
    app: ElectronApplication;
    window: Page;
    /** The throwaway data directory the app was pointed at. */
    userData: string;
}

/**
 * Launch the built app against the isolated cluster. A throwaway user-data directory keeps the
 * real settings out of reach, and the seeded settings pin the kubeconfig, context and namespace
 * so every spec starts from the same deterministic state. `KUBECONFIG` is set as well so even a
 * code path that ignored settings could only reach the test cluster.
 */
export async function launchApp(options: { kubeconfigPath?: string } = {}): Promise<LaunchedApp> {
    const kubeconfigPath = options.kubeconfigPath ?? KUBECONFIG_PATH;
    const userData = mkdtempSync(join(tmpdir(), 'km-e2e-'));
    writeFileSync(
        join(userData, 'settings.json'),
        JSON.stringify({
            version: 1,
            session: { lastContext: CONTEXT_NAME, lastNamespace: NAMESPACE, restoreOnLaunch: true },
            connection: { kubeconfigPath },
        }),
    );
    const app = await electron.launch({
        args: ['out/main/index.mjs'],
        env: {
            ...process.env,
            KUBERMEISTER_USER_DATA: userData,
            KUBECONFIG: kubeconfigPath,
            // Never steal focus: a developer typing during a local run must not drive the app.
            KUBERMEISTER_SHOW_INACTIVE: '1',
        },
    });
    const window = await app.firstWindow();
    // The first window is handed over while index.html may still be loading; a spec that evaluates
    // or clicks before the load settles would hit a destroyed execution context.
    await window.waitForLoadState('domcontentloaded');
    // A spec that launches against its own kubeconfig decides for itself what to wait for.
    if (!options.kubeconfigPath) await window.getByTestId('app-shell').waitFor();
    return { app, window, userData };
}
