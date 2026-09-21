import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { clusterKubectl, NAMESPACE } from '../harness/cluster';
import { launchApp, type LaunchedApp, type Theme } from '../harness/launch';

/**
 * The shot list. Each screenshot is a test of its own so a shot that cannot be composed names
 * itself in the report instead of taking the rest of the set down with it, and they run serially
 * against one app because the sampler's history — what the dashboard charts draw — is main's own
 * memory and starts empty on every launch.
 *
 * Shots navigate by hash rather than by clicking through the sidebar: the router uses hash history,
 * so a route is reachable in one step, and a shot that fails then fails on its own screen rather
 * than on somebody else's breadcrumb.
 */

let launched: LaunchedApp;
let theme: Theme;
let outDir: string;

/** How long the app runs before the dashboard is photographed; the sampler reads every 12 s. */
const SOAK_MS = Number(process.env.KM_DEMO_SOAK_SEC ?? 150) * 1_000;

// Deliberately not `mode: 'serial'`, although the shots do share one app and run in order under a
// single worker: serial mode skips the rest of the file after the first failure, which is the
// opposite of the point. A shot that cannot be composed should name itself and let the other
// nineteen be taken.

test.beforeAll(async () => {
    // One project per theme, so the project's name is which theme this run is shooting.
    theme = test.info().project.name as Theme;
    outDir = resolve('docs/screenshots', theme);
    mkdirSync(outDir, { recursive: true });
    launched = await launchApp(theme);

    // The sampler starts when a reader asks for it, so the dashboard is opened first and then left
    // alone: a chart of one point is a chart of nothing, and its buffers do not survive a relaunch.
    await goto('/overview/summary');
    await launched.window.getByTestId('cluster-summary').waitFor({ timeout: 60_000 });
    await launched.window.waitForTimeout(SOAK_MS);
});

// A shot that failed with a dialog, a popover or the palette still open would otherwise leave it
// over the next one's screen, since the shots share an app.
test.afterEach(async () => {
    await launched?.window.keyboard.press('Escape');
});

test.afterAll(async () => {
    await launched?.app.close();
});

async function goto(path: string): Promise<void> {
    const { window } = launched;
    // `globalThis`, not `window`: inside the callback that name is the Playwright Page above.
    await window.evaluate((hash) => {
        globalThis.location.hash = hash;
    }, `#${path}`);
    // Give the route its first paint and its first read before anything waits on content.
    await window.waitForTimeout(400);
}

/** Settle before the shutter: a row still animating in reads as a rendering bug in a still image. */
async function shoot(name: string): Promise<void> {
    await launched.window.waitForTimeout(600);
    await launched.window.screenshot({ path: resolve(outDir, `${name}.png`) });
}

/** The generated name of one pod of a workload, which no route can guess. */
function podOf(namespace: string, selector: string): string {
    const out = clusterKubectl([
        '-n',
        namespace,
        'get',
        'pods',
        '-l',
        selector,
        '--field-selector=status.phase=Running',
        '-o',
        'jsonpath={.items[0].metadata.name}',
    ]).trim();
    expect(out, `no running pod matched ${selector} in ${namespace}`).not.toBe('');
    return out;
}

function nodeName(): string {
    return clusterKubectl(['get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}']).trim();
}

async function openTab(window: Page, name: string | RegExp): Promise<void> {
    await window.getByRole('tab', { name }).click();
}

// ---------------------------------------------------------------------------------------------
// The website set: the six that say what the app is.
// ---------------------------------------------------------------------------------------------

test('summary', async () => {
    const { window } = launched;
    await goto('/overview/summary');
    const summary = window.getByTestId('cluster-summary');
    await expect(summary).toBeVisible();
    // The alerts panel is the half of this shot that says the app noticed something.
    await expect(summary.getByTestId('alerts')).toBeVisible({ timeout: 60_000 });
    await shoot('summary');
});

test('pod-logs', async () => {
    const { window } = launched;
    const pod = podOf(NAMESPACE, 'app=checkout');
    await goto(`/workloads/pods/${NAMESPACE}/${pod}`);
    await expect(window.getByTestId('pod-page')).toBeVisible({ timeout: 30_000 });
    await openTab(window, 'Logs');
    const viewer = window.getByTestId('log-viewer');
    await expect(viewer).toHaveAttribute('data-live', 'true');
    await expect(viewer.getByRole('list', { name: 'Log lines' })).toContainText('checkout', { timeout: 60_000 });

    // Highlight rather than narrow: the shot has to show both modes existing, and a console emptied
    // down to four ERROR lines says less about the screen than one where the hits sit in context.
    await viewer.getByRole('button', { name: 'Highlight matches' }).click();
    await viewer.getByRole('textbox', { name: 'Filter log lines' }).fill('ERROR');
    await window.waitForTimeout(3_000);
    await shoot('pod-logs');
    await viewer.getByRole('textbox', { name: 'Filter log lines' }).fill('');
    await viewer.getByRole('button', { name: 'Highlight matches' }).click();
});

test('pod-shell', async () => {
    const { window } = launched;
    const pod = podOf(NAMESPACE, 'app=checkout');
    await goto(`/workloads/pods/${NAMESPACE}/${pod}`);
    await openTab(window, 'Shell');
    const terminal = window.getByTestId('terminal-host');
    await expect(terminal.locator('.xterm')).toBeVisible({ timeout: 60_000 });
    await terminal.click();
    // A session with a couple of commands behind it reads as a shell; an empty prompt reads as a
    // terminal that has not connected.
    await window.keyboard.type('ls /etc/checkout\n');
    await window.waitForTimeout(800);
    await window.keyboard.type('cat /etc/checkout/currency.yaml\n');
    await window.waitForTimeout(800);
    await window.keyboard.type('echo $LOG_LEVEL\n');
    await expect(terminal).toContainText('EUR', { timeout: 30_000 });
    await shoot('pod-shell');
});

test('pod-related', async () => {
    const { window } = launched;
    const pod = podOf(NAMESPACE, 'app=checkout');
    await goto(`/workloads/pods/${NAMESPACE}/${pod}`);
    await openTab(window, 'Related');
    // The seeded pod has both cards, so this waits on the one it is sure of rather than on an `or`
    // that matches two elements and trips strict mode.
    await expect(window.getByTestId('related-traffic')).toBeVisible({ timeout: 30_000 });
    await shoot('pod-related');
});

test('pods-grouped', async () => {
    const { window } = launched;
    await goto('/workloads/pods');
    await expect(window.getByTestId('pods-table')).toBeVisible({ timeout: 30_000 });

    // Every namespace at once, grouped by what owns each pod: the headings are interleaved into the
    // virtualised list rather than nesting a table per group, which is the thing to show.
    await window.getByTestId('namespace-selector').click();
    await window.getByRole('option', { name: 'All namespaces' }).click();
    await window.getByRole('combobox', { name: 'Group pods' }).click();
    await window.getByRole('option', { name: 'By owner' }).click();
    await window.waitForTimeout(2_000);
    await shoot('pods-grouped');

    await window.getByRole('combobox', { name: 'Group pods' }).click();
    await window.getByRole('option', { name: 'No grouping' }).click();
    await window.getByTestId('namespace-selector').click();
    await window.getByRole('option', { name: NAMESPACE, exact: true }).click();
    await expect(window.getByTestId('active-namespace')).toContainText(NAMESPACE);
});

test('pods-list', async () => {
    const { window } = launched;
    await goto('/workloads/pods');
    const table = window.getByTestId('pods-table');
    await expect(table).toBeVisible({ timeout: 30_000 });
    // The three deliberately broken workloads are what makes this more than a list of green rows.
    // `CrashLoop` rather than the kubelet's `CrashLoopBackOff`: the list shows a `PodStatus` from
    // the app's own vocabulary, not the raw waiting reason.
    await expect(table).toContainText('CrashLoop', { timeout: 120_000 });
    await shoot('pods-list');
});

// ---------------------------------------------------------------------------------------------
// The documentation set.
// ---------------------------------------------------------------------------------------------

test('command-palette', async () => {
    const { window } = launched;
    await goto('/overview/summary');
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const palette = window.getByRole('dialog', { name: 'Quick actions' });
    await expect(palette).toBeVisible();
    await shoot('command-palette');
    await window.keyboard.press('Escape');
});

test('node-drain-plan', async () => {
    const { window } = launched;
    await goto(`/overview/nodes/${nodeName()}`);
    await expect(window.getByTestId('node-page')).toBeVisible({ timeout: 30_000 });
    await window.getByRole('button', { name: 'Drain' }).click();
    // What a drain would do, before anything is written. Nothing here presses the button.
    await expect(window.getByTestId('drain-plan')).toBeVisible({ timeout: 60_000 });
    await shoot('node-drain-plan');
    await window.keyboard.press('Escape');
});

test('node-detail', async () => {
    const { window } = launched;
    await goto(`/overview/nodes/${nodeName()}`);
    await expect(window.getByTestId('node-page')).toBeVisible({ timeout: 30_000 });
    await shoot('node-detail');
});

test('secret-reveal', async () => {
    const { window } = launched;
    await goto(`/workloads/secrets/${NAMESPACE}/payments-credentials`);
    await expect(window.getByTestId('secret-page')).toBeVisible({ timeout: 30_000 });
    await openTab(window, /Keys/);
    const keys = window.getByTestId('secret-keys');
    await expect(keys).toBeVisible({ timeout: 30_000 });
    // One key revealed and the rest still masked is the whole design: a read crosses the bridge one
    // key at a time, and the revealed one masks itself again on a timer.
    await keys.getByRole('button', { name: 'Reveal DATABASE_URL' }).click();
    await shoot('secret-reveal');
});

test('describe', async () => {
    const { window } = launched;
    const pod = podOf(NAMESPACE, 'app=checkout');
    await goto(`/workloads/pods/${NAMESPACE}/${pod}`);
    await openTab(window, 'Describe');
    await expect(window.getByTestId('describe')).toBeVisible({ timeout: 30_000 });
    await shoot('describe');
});

test('namespace-detail', async () => {
    const { window } = launched;
    await goto(`/overview/namespaces/${NAMESPACE}`);
    await expect(window.getByTestId('namespace-page')).toBeVisible({ timeout: 30_000 });
    await expect(window.getByTestId('namespace-counts')).toBeVisible({ timeout: 30_000 });
    await shoot('namespace-detail');
});

test('crd-instances', async () => {
    const { window } = launched;
    await goto(`/addons/instances/${encodeURIComponent('queues.messaging.example.com')}`);
    const table = window.getByTestId('instances-table');
    await expect(table).toBeVisible({ timeout: 30_000 });
    // The columns are the definition's own `additionalPrinterColumns`, which is the point.
    await expect(table).toContainText('Depth');
    await shoot('crd-instances');
});

test('helm-release', async () => {
    const { window } = launched;
    await goto('/addons/releases/platform/platform-agent');
    await expect(window.getByTestId('release-page')).toBeVisible({ timeout: 30_000 });
    await openTab(window, /Revisions/);
    await expect(window.getByTestId('release-revisions')).toBeVisible({ timeout: 30_000 });
    await shoot('helm-release');
});

test('events', async () => {
    const { window } = launched;
    await goto('/overview/events');
    await expect(window.getByTestId('events-table')).toBeVisible({ timeout: 30_000 });
    await shoot('events');
});

test('workload-logs', async () => {
    const { window } = launched;
    await goto(`/workloads/deployments/${NAMESPACE}/checkout`);
    await expect(window.getByTestId('deployment-page')).toBeVisible({ timeout: 30_000 });
    await openTab(window, 'Logs');
    const viewer = window.getByTestId('log-viewer');
    // Three pods followed at once, each line coloured by the pod it came from.
    await expect(viewer.getByRole('list', { name: 'Log lines' })).toContainText('checkout', { timeout: 90_000 });
    await window.waitForTimeout(4_000);
    await shoot('workload-logs');
});

test('manifest-editor', async () => {
    const { window } = launched;
    await goto(`/workloads/deployments/${NAMESPACE}/checkout`);
    await openTab(window, /Manifest/);
    await expect(window.getByTestId('manifest-panel')).toBeVisible({ timeout: 30_000 });
    await shoot('manifest-editor');
});

test('settings', async () => {
    const { window } = launched;
    await goto('/settings');
    await expect(window.getByTestId('settings-page')).toBeVisible({ timeout: 30_000 });
    await shoot('settings');
});

test('port-forwards', async () => {
    const { window } = launched;
    await goto(`/network/services/${NAMESPACE}/checkout`);
    await expect(window.getByTestId('service-page')).toBeVisible({ timeout: 30_000 });
    await openTab(window, 'Ports');
    await window.getByRole('textbox', { name: 'Local port' }).fill('38090');
    await window.getByRole('button', { name: 'Start' }).click();
    await expect(window.getByTestId('port-forward-status')).toContainText('Listening', { timeout: 30_000 });

    // Listed and stopped from the top bar, not from the page that started one.
    await window.getByRole('button', { name: 'Port forwards' }).click();
    await expect(window.getByTestId('forward-list')).toBeVisible();
    await shoot('port-forwards');
    await window
        .getByTestId('forward-list')
        .getByRole('button', { name: /^Stop forward/ })
        .click();
    await window.keyboard.press('Escape');
});

// Last of the set: it writes to the cluster, which rolls the pods every earlier shot was taken
// against and resets their ages.
test('deployment-compare', async () => {
    const { window } = launched;
    await goto(`/workloads/deployments/${NAMESPACE}/checkout`);
    const page = window.getByTestId('deployment-page');
    await expect(page).toBeVisible({ timeout: 30_000 });
    // A second revision to compare against: the demo cluster is seeded with one rollout only.
    await page.getByRole('button', { name: 'Restart' }).click();
    await window.getByRole('alertdialog').getByRole('button', { name: 'Restart' }).click();
    await openTab(window, /History/);
    await expect(page.getByTestId('rollout-history').locator('[data-revision="2"]')).toBeVisible({ timeout: 60_000 });
    const diff = page.getByTestId('revision-diff');
    await expect(diff).toBeVisible({ timeout: 60_000 });
    await shoot('deployment-compare');
});
