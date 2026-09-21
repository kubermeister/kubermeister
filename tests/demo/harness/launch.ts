import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_NAME, KUBECONFIG_PATH, NAMESPACE } from './cluster';

export type Theme = 'dark' | 'light';

export interface LaunchedApp {
    app: ElectronApplication;
    window: Page;
    userData: string;
}

/**
 * Every shot is taken at the same size, so the whole set crops and scales alike on a page. The
 * renderer cannot set `window.bounds` through `settings.set` (`settingsInputSchema` omits the
 * section), but the harness writes the settings file itself, which is how a screenshot run pins the
 * window instead of photographing whatever size the last person left it at.
 */
export const WINDOW = { x: 40, y: 40, width: 1440, height: 900 };

export async function launchApp(theme: Theme): Promise<LaunchedApp> {
    const userData = mkdtempSync(join(tmpdir(), 'km-demo-'));
    writeFileSync(
        join(userData, 'settings.json'),
        JSON.stringify({
            version: 1,
            session: { lastContext: CONTEXT_NAME, lastNamespace: NAMESPACE, restoreOnLaunch: true },
            connection: { kubeconfigPath: KUBECONFIG_PATH },
            // An "Update available" pill would leak into half the shots, and a shot is worth more
            // when its lists are moving, so the refresh cadence is the quickest one Settings offers.
            updates: { mode: 'off', checkIntervalHours: 4 },
            data: { refreshIntervalSec: 5, readTimeoutSec: 60, logBufferLines: 2_000, terminalFontSize: 13 },
            window: { bounds: WINDOW },
        }),
    );

    // `--force-device-scale-factor=2` is off by default: a retina Mac already captures at 2x, and
    // forcing it on a 1x display would ask for a window twice the size of the screen.
    const args = ['out/main/index.mjs'];
    if (process.env.KM_DEMO_SCALE) args.push(`--force-device-scale-factor=${process.env.KM_DEMO_SCALE}`);

    const app = await electron.launch({
        args,
        env: {
            ...process.env,
            KUBERMEISTER_USER_DATA: userData,
            KUBECONFIG: KUBECONFIG_PATH,
            // Never steal focus: a run takes minutes and the developer keeps typing elsewhere.
            KUBERMEISTER_SHOW_INACTIVE: '1',
        },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // The theme is renderer `localStorage`, read by `ThemeProvider` as it mounts, so it is written
    // and the window reloaded rather than toggled through the UI, which would leave the Settings
    // screen on show in every shot.
    await window.evaluate((value) => localStorage.setItem('km-theme', value), theme);
    await window.reload();
    await window.waitForLoadState('domcontentloaded');
    await window.getByTestId('app-shell').waitFor({ timeout: 60_000 });
    return { app, window, userData };
}
