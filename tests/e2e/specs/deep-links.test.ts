import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { CONTEXT_NAME, NAMESPACE, clusterKubectl } from '../harness/cluster';
import { appEnv, closeApp, launchApp, type LaunchedApp } from '../harness/launch';

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
    if (launched) await closeApp(launched);
    launched = undefined;
});

const link = (context: string, path: string) => `kubermeister://open/${encodeURIComponent(context)}${path}`;

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
    launched = await launchApp({ args: [link(CONTEXT_NAME, `/workloads/pods/${NAMESPACE}/${pod}/shell`)] });
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
            'out/main/index.mjs',
            link(CONTEXT_NAME, `/workloads/deployments/${NAMESPACE}/web/manifest`),
        ],
        { env: appEnv(launched.userData), timeout: 60_000 },
    );
    // The lock is held, so the second process quits on its own rather than timing out.
    expect(second.error).toBeUndefined();
    expect(second.status).toBe(0);
    await expect(launched.window.getByTestId('deployment-page')).toBeVisible();
    await expect.poll(() => routeOf(launched!)).toBe(`/workloads/deployments/${NAMESPACE}/web/manifest`);
});

test('says so for a context the kubeconfig does not have, and stays on its own', async () => {
    launched = await launchApp({ args: [link('somebody-elses-cluster', '/workloads/pods')] });
    await expect(launched.window.getByText('Context not in your kubeconfig')).toBeVisible();
    await expect(launched.window.getByTestId('context-selector')).toHaveText(CONTEXT_NAME);
});
