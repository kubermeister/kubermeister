import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { KUBECONFIG_PATH, NAMESPACE, clusterKubectl } from '../harness/cluster';
import { closeApp, launchApp, type LaunchedApp } from '../harness/launch';

/*
 * Installing a chart end to end: a fixture repository served from this process, the chart packaged
 * and indexed by the real Helm, rendered through the app's own `helm template` and written through
 * the app's own write path into the k3s cluster. The Helm CLI then reads the release back from the
 * cluster, which is the proof that the release Secret is one Helm recognises, and uninstalls it.
 */

const CHART_DIR = resolve('tests/e2e/fixtures/charts/km-demo');
const RELEASE = 'km-demo';
const INSTALL_PATH = '#/helm/charts/install/fixture/km-demo/0.1.0';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

let helmHome: string;
let repoDir: string;
let server: Server;
let repoUrl: string;
let launched: LaunchedApp;

/** The Helm CLI, pointed at the test cluster alone and at a Helm home of its own. */
function helm(args: string[]): string {
    return execFileSync('helm', args, {
        encoding: 'utf8',
        // A failure throws with Helm's stderr on it; a call expected to fail should not print it too.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            PATH: process.env.PATH,
            HOME: helmHome,
            HELM_CACHE_HOME: join(helmHome, 'cache'),
            HELM_CONFIG_HOME: join(helmHome, 'config'),
            HELM_DATA_HOME: join(helmHome, 'data'),
            KUBECONFIG: KUBECONFIG_PATH,
        },
    });
}

/** Take away whatever a previous run left, so a kept cluster starts this spec from nothing. */
function forgetRelease(): void {
    try {
        helm(['uninstall', RELEASE, '--namespace', NAMESPACE, '--kubeconfig', KUBECONFIG_PATH]);
    } catch {
        // Not installed, which is the usual case.
    }
    clusterKubectl([
        '-n',
        NAMESPACE,
        'delete',
        'configmap,job',
        `${RELEASE}-installed`,
        `${RELEASE}-prepare`,
        '--ignore-not-found',
    ]);
}

test.beforeAll(async () => {
    helmHome = mkdtempSync(join(tmpdir(), 'km-e2e-helm-'));
    repoDir = mkdtempSync(join(tmpdir(), 'km-e2e-repo-'));
    server = createServer((request, response) => {
        const file = join(repoDir, (request.url ?? '/').split('?')[0]!.replace(/^\/+/, ''));
        if (!file.startsWith(repoDir) || !existsSync(file)) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200);
        createReadStream(file).pipe(response);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    repoUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    helm(['package', CHART_DIR, '--destination', repoDir]);
    helm(['repo', 'index', repoDir, '--url', repoUrl]);
    forgetRelease();
});

test.afterAll(async () => {
    await new Promise((done) => server.close(done));
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(helmHome, { recursive: true, force: true });
});

test.beforeEach(async () => {
    launched = await launchApp({
        settings: { charts: { repositories: [{ name: 'fixture', kind: 'classic', url: repoUrl }] } },
    });
});

test.afterEach(async () => {
    await closeApp(launched);
});

async function replaceValues(text: string): Promise<void> {
    const editor = launched.window.getByTestId('install-chart-page').locator('.cm-content');
    await editor.click();
    await launched.window.keyboard.press(`${mod}+a`);
    await launched.window.keyboard.insertText(text);
}

test('installs a chart through a reviewed render, and the Helm CLI reads the release back', async () => {
    const { window } = launched;
    // The way in is the chart's row under Helm › Charts, which reads the repository's index itself.
    await window.getByTestId('sidebar').getByRole('link', { name: 'Charts', exact: true }).click();
    const row = window.getByTestId('charts-table').locator(`[data-chart="fixture/${RELEASE}"]`);
    await expect(row).toContainText('0.1.0');
    await row.getByRole('button', { name: `Install ${RELEASE}` }).click();
    await expect(window).toHaveURL(new RegExp(`${INSTALL_PATH}$`));
    const page = window.getByTestId('install-chart-page');
    await expect(page.locator('.cm-content')).toContainText('greeting: hello');
    await expect(page.getByRole('textbox', { name: 'Release name' })).toHaveValue(RELEASE);

    // A null deletes the chart's default, so the template's `required` fails, in Helm's own words.
    await replaceValues('enabled: yes\ngreeting: null\nreplicas: 1\n');
    await page.getByRole('button', { name: 'Review' }).click();
    await expect(page.getByTestId('values-render-error')).toContainText('a greeting is required');

    await replaceValues('enabled: yes\ngreeting: from the e2e suite\nreplicas: 1\n');
    await page.getByRole('button', { name: 'Review' }).click();
    const review = page.getByTestId('install-review');
    await expect(review).toBeVisible({ timeout: 60_000 });
    await expect(review.getByTestId('install-review-lookup')).toBeVisible();
    for (const object of [`ConfigMap/${RELEASE}-settings`, `Deployment/${RELEASE}-web`, `Job/${RELEASE}-prepare`]) {
        await expect(review.locator(`[data-object="${object}"]`)).toHaveAttribute('data-check', 'passed');
    }

    await page.getByRole('button', { name: `Install ${RELEASE}` }).click();
    const release = window.getByTestId('release-page');
    await expect(release).toBeVisible({ timeout: 90_000 });
    await expect(window).toHaveURL(new RegExp(`#/helm/releases/${NAMESPACE}/${RELEASE}$`));
    await expect(
        release.getByTestId('release-resources').locator(`[data-object="Deployment/${RELEASE}-web"]`),
    ).toBeVisible();

    // Only the greeting differs from the chart's defaults, so only it reached Helm, which read `enabled`
    // from the chart's own values.yaml as YAML 1.1: `yes` is true, exactly as `helm install` renders it.
    const settings = JSON.parse(
        clusterKubectl(['-n', NAMESPACE, 'get', 'configmap', `${RELEASE}-settings`, '-o', 'json']),
    ) as { data: Record<string, string> };
    expect(settings.data).toMatchObject({ enabled: 'true', greeting: 'from the e2e suite', seenBefore: 'no' });
    // The pre-install hook asked to go once it succeeded; the post-install one did not.
    expect(clusterKubectl(['-n', NAMESPACE, 'get', 'job', `${RELEASE}-prepare`, '--ignore-not-found'])).toBe('');
    expect(clusterKubectl(['-n', NAMESPACE, 'get', 'configmap', `${RELEASE}-installed`, '-o', 'name'])).toContain(
        `${RELEASE}-installed`,
    );

    const listed = JSON.parse(helm(['list', '--namespace', NAMESPACE, '--output', 'json'])) as {
        name: string;
        status: string;
        chart: string;
        revision: string;
    }[];
    expect(listed.find((one) => one.name === RELEASE)).toMatchObject({
        status: 'deployed',
        chart: 'km-demo-0.1.0',
        revision: '1',
    });
    // The release's config is the user's overrides alone, as for a release the Helm CLI installed.
    expect(JSON.parse(helm(['get', 'values', RELEASE, '--namespace', NAMESPACE, '--output', 'json']))).toEqual({
        greeting: 'from the e2e suite',
    });
    expect(helm(['get', 'hooks', RELEASE, '--namespace', NAMESPACE])).toContain(`${RELEASE}-prepare`);

    // A second install under the same name is refused before anything renders.
    await window.evaluate((path) => {
        window.location.hash = path;
    }, INSTALL_PATH);
    await window.getByTestId('install-chart-page').getByRole('button', { name: 'Review' }).click();
    await expect(
        window.getByText(`A release named "${RELEASE}" already exists in namespace ${NAMESPACE}.`),
    ).toBeVisible();

    // And the Helm CLI can act on the release, not only read it: it deletes only what carries the
    // ownership metadata it stamps, so an object left behind is one the app did not stamp. `--wait`
    // returns once the objects are gone rather than once their deletion was accepted.
    const uninstalled = helm(['uninstall', RELEASE, '--namespace', NAMESPACE, '--wait', '--timeout', '60s']);
    expect(uninstalled).not.toContain('not owned by this release');
    expect(clusterKubectl(['-n', NAMESPACE, 'get', 'deployment', `${RELEASE}-web`, '--ignore-not-found'])).toBe('');
    clusterKubectl(['-n', NAMESPACE, 'delete', 'configmap', `${RELEASE}-installed`, '--ignore-not-found']);
});
