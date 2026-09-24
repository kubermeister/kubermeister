import { _electron as electron, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
export async function launchApp(
    options: { kubeconfigPath?: string; restoreContext?: boolean; args?: string[] } = {},
): Promise<LaunchedApp> {
    const kubeconfigPath = options.kubeconfigPath ?? KUBECONFIG_PATH;
    // A spec about the file's own current-context must not have the remembered one restored over it.
    const restoreOnLaunch = options.restoreContext ?? true;
    const userData = mkdtempSync(join(tmpdir(), 'km-e2e-'));
    writeFileSync(
        join(userData, 'settings.json'),
        JSON.stringify({
            version: 1,
            session: { lastContext: CONTEXT_NAME, lastNamespace: NAMESPACE, restoreOnLaunch },
            connection: { kubeconfigPath },
        }),
    );
    const app = await electron.launch({
        // Anything after the entry point is what the OS passes a launch, such as a link.
        args: ['out/main/index.mjs', ...(options.args ?? [])],
        env: appEnv(userData, kubeconfigPath),
    });
    if (traceMode() !== 'off') await app.context().tracing.start({ screenshots: true, snapshots: true });
    const window = await app.firstWindow();
    // The first window is handed over while index.html may still be loading; a spec that evaluates
    // or clicks before the load settles would hit a destroyed execution context.
    await window.waitForLoadState('domcontentloaded');
    // A spec that launches against its own kubeconfig decides for itself what to wait for.
    if (!options.kubeconfigPath) await window.getByTestId('app-shell').waitFor();
    return { app, window, userData };
}

/** The environment every launch of the app under test runs with, a second launch included. */
export function appEnv(userData: string, kubeconfigPath = KUBECONFIG_PATH): NodeJS.ProcessEnv {
    return {
        ...process.env,
        KUBERMEISTER_USER_DATA: userData,
        KUBECONFIG: kubeconfigPath,
        // Never steal focus: a developer typing during a local run must not drive the app.
        KUBERMEISTER_SHOW_INACTIVE: '1',
    };
}

/**
 * Playwright's `trace` option only reaches the contexts its own fixtures create, never one that
 * `_electron.launch` hands back, so the harness records the trace itself under the mode the config
 * names.
 */
function traceMode(): string {
    const trace = test.info().project.use.trace;
    return (typeof trace === 'string' ? trace : trace?.mode) ?? 'off';
}

/**
 * Close the app, keeping what a failure needs to be read afterwards: the trace, and the window's own
 * state as main and the renderer see it. A click that waits for a stable element measures it over
 * animation frames, so a window that stopped painting hangs there without saying why (#364); the
 * state answers whether the window was shown, focused and still producing frames.
 */
export async function closeApp({ app, window, userData }: LaunchedApp): Promise<void> {
    const info = test.info();
    const failed = info.status !== info.expectedStatus;
    if (failed) await attachWindowState(app, window);
    const mode = traceMode();
    if (mode !== 'off') {
        const keep = mode === 'on' || failed;
        const path = keep ? info.outputPath(`trace-${basename(userData)}.zip`) : undefined;
        await app.context().tracing.stop({ path });
        if (path) await info.attach('trace', { path, contentType: 'application/zip' });
    }
    await app.close();
}

async function attachWindowState(app: ElectronApplication, window: Page): Promise<void> {
    const main = await app
        .evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().map((w) => ({
                visible: w.isVisible(),
                focused: w.isFocused(),
                minimized: w.isMinimized(),
                bounds: w.getBounds(),
                backgroundThrottling: w.webContents.getBackgroundThrottling(),
            })),
        )
        .catch((error: unknown) => String(error));
    const renderer = await window
        .evaluate(
            () =>
                new Promise((resolve) => {
                    const state = { visibilityState: document.visibilityState, hasFocus: document.hasFocus() };
                    const timer = setTimeout(() => resolve({ ...state, animationFrame: false }), 1000);
                    requestAnimationFrame(() => {
                        clearTimeout(timer);
                        resolve({ ...state, animationFrame: true });
                    });
                }),
        )
        .catch((error: unknown) => String(error));
    await test.info().attach('window-state', {
        body: JSON.stringify({ main, renderer }, null, 2),
        contentType: 'application/json',
    });
    await window.screenshot({ timeout: 5000 }).then(
        (body) => test.info().attach('window', { body, contentType: 'image/png' }),
        () => undefined,
    );
}
