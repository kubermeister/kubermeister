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
 * Upgrading a release end to end. The Helm CLI installs 0.1.0 of the fixture chart, so the release
 * the app upgrades is one Helm wrote, then the app upgrades it to 0.2.0 from a fixture repository
 * serving both: its own `helm template`, its own write path, into the k3s cluster. The Helm CLI then
 * reads the new revision back and uninstalls the release, which is the proof that the history and the
 * objects are ones Helm recognises as its own.
 */

const OLD_CHART = resolve('tests/e2e/fixtures/charts/km-demo');
const NEW_CHART = resolve('tests/e2e/fixtures/charts/km-demo-next');
const RELEASE = 'km-up';
const UPGRADE_PATH = `#/helm/releases/${NAMESPACE}/${RELEASE}/upgrade`;
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
        helm(['uninstall', RELEASE, '--namespace', NAMESPACE, '--wait', '--timeout', '60s']);
    } catch {
        // Not installed, which is the usual case.
    }
    clusterKubectl([
        '-n',
        NAMESPACE,
        'delete',
        'configmap,job',
        `${RELEASE}-installed`,
        `${RELEASE}-upgraded`,
        `${RELEASE}-prepare`,
        `${RELEASE}-migrate`,
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
    helm(['package', OLD_CHART, '--destination', repoDir]);
    helm(['package', NEW_CHART, '--destination', repoDir]);
    helm(['repo', 'index', repoDir, '--url', repoUrl]);
    forgetRelease();
    helm([
        'install',
        RELEASE,
        join(repoDir, 'km-demo-0.1.0.tgz'),
        '--namespace',
        NAMESPACE,
        '--set',
        'greeting=from the cli',
        '--wait',
        '--timeout',
        '90s',
    ]);
});

test.afterAll(async () => {
    forgetRelease();
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

test('upgrades a release Helm installed through a reviewed diff, and the Helm CLI reads it back', async () => {
    const { window } = launched;
    await window.evaluate((path) => {
        window.location.hash = path;
    }, UPGRADE_PATH);
    const page = window.getByTestId('upgrade-release-page');
    // The values start from the release's own, and the version from the newest the repository lists.
    await expect(page.locator('.cm-content')).toContainText('greeting: from the cli', { timeout: 30_000 });
    await expect(page.getByRole('combobox', { name: 'Chart version' })).toHaveText(/0\.2\.0/);

    const editor = page.locator('.cm-content');
    await editor.click();
    await window.keyboard.press(`${mod}+a`);
    await window.keyboard.insertText('greeting: upgraded\n');
    await page.getByRole('button', { name: 'Review' }).click();

    const review = page.getByTestId('upgrade-review');
    await expect(review).toBeVisible({ timeout: 60_000 });
    const values = review.getByTestId('upgrade-review-values');
    await expect(values.locator('[data-diff="removed"]')).toContainText('greeting: from the cli');
    await expect(values.locator('[data-diff="added"]')).toContainText('greeting: upgraded');
    const settings = review.locator(`[data-object="ConfigMap/${RELEASE}-settings"]`);
    await expect(settings).toHaveAttribute('data-change', 'update');
    await expect(settings).toHaveAttribute('data-check', 'passed');
    // The diff is the live object against the dry run's answer, so only what the render changes shows.
    await settings.getByRole('button').click();
    await expect(settings.locator('[data-diff="added"]')).toContainText(['greeting: upgraded', "upgraded: 'true'"]);
    await expect(review.locator(`[data-object="ConfigMap/${RELEASE}-extra"]`)).toHaveAttribute('data-change', 'create');
    await expect(
        review.getByTestId('upgrade-review-removed').locator(`[data-object="Deployment/${RELEASE}-web"]`),
    ).toContainText('Deleted');
    await expect(review.locator(`[data-object="Job/${RELEASE}-migrate"]`)).toContainText('pre-upgrade');

    await page.getByRole('button', { name: 'Upgrade to revision 2' }).click();
    await expect(window.getByTestId('release-page')).toBeVisible({ timeout: 90_000 });
    await expect(window).toHaveURL(new RegExp(`#/helm/releases/${NAMESPACE}/${RELEASE}$`));

    // What the cluster holds now: the render of 0.2.0, the dropped Deployment gone, the hooks run.
    const data = JSON.parse(
        clusterKubectl(['-n', NAMESPACE, 'get', 'configmap', `${RELEASE}-settings`, '-o', 'json']),
    ) as { data: Record<string, string> };
    // `enabled` was never given, so it is the chart's own default, which Helm reads from its values.yaml
    // as YAML 1.1: `yes` is true, exactly as `helm upgrade` renders it.
    expect(data.data).toMatchObject({ greeting: 'upgraded', enabled: 'true', upgraded: 'true' });
    expect(clusterKubectl(['-n', NAMESPACE, 'get', 'configmap', `${RELEASE}-extra`, '-o', 'name'])).toContain(
        `${RELEASE}-extra`,
    );
    await expect
        .poll(() => clusterKubectl(['-n', NAMESPACE, 'get', 'deployment', `${RELEASE}-web`, '--ignore-not-found']))
        .toBe('');
    expect(clusterKubectl(['-n', NAMESPACE, 'get', 'job', `${RELEASE}-migrate`, '--ignore-not-found'])).toBe('');
    expect(clusterKubectl(['-n', NAMESPACE, 'get', 'configmap', `${RELEASE}-upgraded`, '-o', 'name'])).toContain(
        `${RELEASE}-upgraded`,
    );

    // And what Helm reads: a new revision numbered forward, the old one superseded, the new values.
    const history = JSON.parse(helm(['history', RELEASE, '--namespace', NAMESPACE, '--output', 'json'])) as {
        revision: number;
        status: string;
        chart: string;
        description: string;
    }[];
    expect(history.map(({ revision, status, chart }) => ({ revision, status, chart }))).toEqual([
        { revision: 1, status: 'superseded', chart: 'km-demo-0.1.0' },
        { revision: 2, status: 'deployed', chart: 'km-demo-0.2.0' },
    ]);
    expect(history[1]!.description).toBe('Upgrade complete');
    expect(JSON.parse(helm(['get', 'values', RELEASE, '--namespace', NAMESPACE, '--output', 'json']))).toEqual({
        greeting: 'upgraded',
    });
    expect(helm(['get', 'hooks', RELEASE, '--namespace', NAMESPACE])).toContain(`${RELEASE}-migrate`);

    // Helm deletes only what carries the ownership it stamps, so nothing left behind means every object
    // the upgrade wrote carries it.
    const uninstalled = helm(['uninstall', RELEASE, '--namespace', NAMESPACE, '--wait', '--timeout', '60s']);
    expect(uninstalled).not.toContain('not owned by this release');
    expect(clusterKubectl(['-n', NAMESPACE, 'get', 'configmap', `${RELEASE}-extra`, '--ignore-not-found'])).toBe('');
    expect(clusterKubectl(['-n', NAMESPACE, 'get', 'configmap', `${RELEASE}-settings`, '--ignore-not-found'])).toBe('');
});
