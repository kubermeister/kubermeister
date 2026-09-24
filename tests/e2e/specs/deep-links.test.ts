import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeServer } from '../../../src/shared/deep-link';
import { CONTEXT_NAME, KUBECONFIG_PATH, NAMESPACE, clusterKubectl } from '../harness/cluster';
import { appEnv, closeApp, launchApp, type LaunchedApp } from '../harness/launch';

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
    if (launched) await closeApp(launched);
    launched = undefined;
});

const link = (server: string, path: string) => `kubermeister://open/${encodeURIComponent(server)}${path}`;

/** The test cluster's API server, which is how a link names it. */
function testServer(): string {
    const config = loadYaml(readFileSync(KUBECONFIG_PATH, 'utf8')) as { clusters: { cluster: { server: string } }[] };
    return normalizeServer(config.clusters[0]!.cluster.server)!;
}

/** The route the window shows, read from its hash history. */
async function routeOf({ window }: LaunchedApp): Promise<string> {
    return window.evaluate(() => location.hash.replace(/^#/, ''));
}

test('opens the link a launch carries, on the pod’s first tab rather than its shell', async () => {
    const pod = clusterKubectl([
        '-n',
        NAMESPACE,
        'get',
        'pods',
        '-l',
        'app=web',
        '-o',
        'jsonpath={.items[0].metadata.name}',
    ]);
    expect(pod).not.toBe('');
    launched = await launchApp({ args: [link(testServer(), `/workloads/pods/${NAMESPACE}/${pod}/shell`)] });
    await expect(launched.window.getByTestId('pod-page')).toContainText(pod);
    await expect.poll(() => routeOf(launched!)).toBe(`/workloads/pods/${NAMESPACE}/${pod}`);
    await expect(launched.window.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');
});

test('a second launch hands its link to the running app and quits', async () => {
    launched = await launchApp();
    const second = spawnSync(
        process.execPath,
        [
            'node_modules/electron/cli.js',
            // What Playwright passes its own Linux launches: a runner's development Electron has no
            // root-owned chrome-sandbox, and Chromium aborts rather than start without one.
            ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
            'out/main/index.mjs',
            link(testServer(), `/workloads/deployments/${NAMESPACE}/web/manifest`),
        ],
        { env: appEnv(launched.userData), timeout: 60_000 },
    );
    // The lock is held, so the second process quits on its own rather than timing out; what it
    // printed is the only account of why when it does not.
    const output = `${second.stdout}\n${second.stderr}`;
    expect(second.error, output).toBeUndefined();
    expect(second.status, output).toBe(0);
    await expect(launched.window.getByTestId('deployment-page')).toBeVisible();
    await expect.poll(() => routeOf(launched!)).toBe(`/workloads/deployments/${NAMESPACE}/web/manifest`);
});

test('says so for a cluster no context reaches, and stays on its own', async () => {
    launched = await launchApp({ args: [link('https://somebody-elses-cluster.example.com', '/workloads/pods')] });
    await expect(launched.window.getByText('No context for that cluster')).toBeVisible();
    await expect(launched.window.getByTestId('context-selector')).toHaveText(CONTEXT_NAME);
});

test('says a pod the reader may not see is denied, rather than only that it failed', async () => {
    // A service account bound to nothing: it authenticates, and every read it makes is forbidden.
    const account = 'km-e2e-denied';
    // A kept cluster already has it from an earlier run.
    if (!clusterKubectl(['-n', NAMESPACE, 'get', 'serviceaccount', '--ignore-not-found', '-o', 'name', account]))
        clusterKubectl(['-n', NAMESPACE, 'create', 'serviceaccount', account]);
    const token = clusterKubectl(['-n', NAMESPACE, 'create', 'token', account]).trim();
    const seeded = loadYaml(readFileSync(KUBECONFIG_PATH, 'utf8')) as { users: { user: Record<string, string> }[] };
    seeded.users[0]!.user = { token };
    const denied = join(tmpdir(), `km-e2e-denied-${Date.now()}.yaml`);
    writeFileSync(denied, dumpYaml(seeded));

    launched = await launchApp({
        kubeconfigPath: denied,
        args: [link(testServer(), `/workloads/pods/${NAMESPACE}/web-denied`)],
    });
    const panel = launched.window.getByTestId('detail-error');
    await expect(panel).toContainText('Access denied');
    await expect(panel).toContainText("You don't have permission to view this Pod.");
    await expect(panel).toContainText('Access denied (RBAC).');
    await expect(panel.getByRole('button', { name: 'Retry' })).toBeVisible();
});
