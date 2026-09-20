import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_NAME, NAMESPACE, clusterKubectl } from '../harness/cluster';
import { launchApp, type LaunchedApp } from '../harness/launch';

let launched: LaunchedApp;

test.beforeEach(async () => {
    launched = await launchApp();
});

test.afterEach(async () => {
    await launched.app.close();
});

test('passes the startup gate against the isolated cluster and shows the shell', async () => {
    const { window } = launched;
    await expect(window).toHaveTitle('Kubermeister');
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await expect(window.getByTestId('context-selector')).toHaveText(CONTEXT_NAME);
    await expect(window.getByTestId('active-namespace')).toContainText(NAMESPACE);
});

test('shows the cluster summary for the test context', async () => {
    const { window } = launched;
    const summary = window.getByTestId('cluster-summary');
    await expect(summary).toContainText(CONTEXT_NAME);
    await expect(summary).toContainText('Healthy');
    await expect(summary.locator('[data-metric="Nodes"]')).toContainText('1');
    await expect(summary.getByTestId('workload-health')).toContainText('live · ~12s samples');
    // Which events are recent enough to show depends on what the cluster has been doing, so this
    // asserts that events render at all rather than naming one that can age out of the list.
    await expect(summary.getByTestId('recent-events').getByRole('listitem').first()).toBeVisible();
});

test('lists the k3s node as Ready and the seeded namespace', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Nodes', exact: true }).click();
    const nodes = window.getByTestId('nodes-table');
    await expect(nodes.getByRole('row')).toHaveCount(2);
    await expect(nodes).toContainText('Ready');
    await expect(nodes).toContainText('control-plane');
    // Usage meters fill in once metrics-server has reported the node; until then the cell says so.
    await expect(
        nodes.getByRole('progressbar', { name: 'CPU usage' }).or(nodes.getByText('no data').first()),
    ).toBeVisible();

    await nodes.locator('[data-node]').first().getByRole('link').click();
    const nodePage = window.getByTestId('node-page');
    await expect(nodePage).toContainText('role: control-plane');
    await window.getByRole('tab', { name: 'System info' }).click();
    await expect(nodePage.getByTestId('system-info')).toContainText('v1.36.4+k3s1');
    await window.getByRole('tab', { name: /Conditions/ }).click();
    await expect(nodePage.getByTestId('node-conditions')).toContainText('Ready: True');
    await window.getByTestId('sidebar').getByRole('link', { name: 'Nodes', exact: true }).click();

    await window.getByRole('link', { name: 'Namespaces' }).click();
    const namespaces = window.getByTestId('namespaces-table');
    await expect(namespaces.locator(`[data-namespace="${NAMESPACE}"]`)).toContainText('Active');
    await expect(namespaces.locator('[data-namespace="kube-system"]')).toBeVisible();
});

test('keeps all per-user state inside the throwaway data directory', async () => {
    const { app, userData } = launched;
    const actual = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    expect(actual).toBe(userData);
    expect(existsSync(join(userData, 'settings.json'))).toBe(true);
});

test('reads the cluster node list through the bridge', async () => {
    // Named `page` so that `window` inside the callback is the renderer's global, not the Playwright Page.
    const { window: page } = launched;
    const result = await page.evaluate(() => window.km.invoke('nodes.list', {}));
    expect(result).toMatchObject({ ok: true });
    const nodes = (result as { data: Array<{ status: string; role: string }> }).data;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ status: 'Ready' });
});

test('lists the seeded pod, opens its detail, and rescopes by namespace', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Pods' }).click();
    const pods = window.getByTestId('pods-table');
    const row = pods.locator('[data-pod^="web-"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Running');
    // The seeded container declares limits, so usage renders as a meter even before the first sample.
    await expect(row.getByRole('progressbar', { name: 'CPU usage' })).toBeVisible();
    await expect(row.getByRole('progressbar', { name: 'Memory usage' })).toBeVisible();

    await row.getByRole('link').click();
    // The header carries the namespace; the list only shows a Namespace column across namespaces.
    const page = window.getByTestId('pod-page');
    await expect(page).toContainText(`namespace: ${NAMESPACE}`);
    const containers = page.getByTestId('containers');
    await expect(containers).toContainText('busybox:1.36');
    await expect(containers.locator('[data-container="web"]')).toContainText('Running');
    await window.getByRole('tab', { name: 'Events' }).click();
    await expect(page.getByTestId('object-events')).toContainText('Scheduled');
    await window.getByRole('tab', { name: 'Network' }).click();
    await expect(page.getByTestId('network')).toContainText('8080/TCP');

    // Rescoping from the detail closes it back to the list: the pod on screen belongs to the namespace being left.
    await window.getByTestId('namespace-selector').click();
    await window.getByRole('option', { name: 'kube-system' }).click();
    await expect(window.getByTestId('active-namespace')).toContainText('kube-system');
    await expect(page).toHaveCount(0);
    await expect(window.getByTestId('pods-table').locator('[data-pod^="web-"]')).toHaveCount(0);
    await expect(window.getByTestId('pods-table').locator('[data-pod^="coredns-"]')).toHaveCount(1);
});

test('keeps the pod list live: a deleted pod disappears and its replacement appears', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Pods' }).click();
    const page = window.getByTestId('pods-page');
    const rows = page.locator('[data-pod^="web-"]');
    await expect(rows).toHaveCount(1);
    await expect(page).toHaveAttribute('data-live', 'true');
    const victim = await rows.first().getAttribute('data-pod');
    expect(victim).toBeTruthy();

    clusterKubectl(['-n', NAMESPACE, 'delete', 'pod', victim!, '--wait=false']);

    await expect(page.locator(`[data-pod="${victim}"]`)).toHaveCount(0, { timeout: 45_000 });
    const replacement = page.locator('[data-pod^="web-"]');
    await expect(replacement).toHaveCount(1, { timeout: 45_000 });
    await expect(replacement).toContainText('Running', { timeout: 60_000 });
    expect(await replacement.getAttribute('data-pod')).not.toBe(victim);
});

test('follows pod logs, runs a command in the pod shell, and starts a port-forward', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Pods' }).click();
    await window.getByTestId('pods-table').locator('[data-pod^="web-"]').getByRole('link').click();
    await expect(window.getByTestId('pod-page')).toBeVisible();

    await window.getByRole('tab', { name: 'Logs' }).click();
    const viewer = window.getByTestId('log-viewer');
    // The snapshot read shows recent lines first; Live switches to the follow stream.
    await expect(viewer.getByRole('list', { name: 'Log lines' })).toContainText('km-e2e-marker', { timeout: 30_000 });
    await expect(viewer).toHaveAttribute('data-live', 'false');
    await window.getByRole('button', { name: 'Live' }).click();
    await expect(viewer).toHaveAttribute('data-live', 'true', { timeout: 30_000 });
    await expect(viewer.getByRole('list', { name: 'Log lines' })).toContainText('km-e2e-marker', { timeout: 30_000 });

    // The console's own controls: the marker survives a case-sensitive search for it, and a search
    // in the wrong case empties the console.
    const rows = viewer.getByRole('list', { name: 'Log lines' });
    await window.getByRole('button', { name: 'Aa' }).click();
    await viewer.getByRole('textbox', { name: 'Filter log lines' }).fill('km-e2e-marker');
    await expect(rows).toContainText('km-e2e-marker');
    await viewer.getByRole('textbox', { name: 'Filter log lines' }).fill('KM-E2E-MARKER');
    await expect(viewer.getByTestId('log-status')).toContainText('0 lines', { timeout: 30_000 });
    await viewer.getByRole('textbox', { name: 'Filter log lines' }).fill('');
    await window.getByRole('button', { name: 'Aa' }).click();
    await expect(rows).toContainText('km-e2e-marker');

    // The shell is the pod's own, in its Shell tab.
    await window.getByRole('tab', { name: 'Shell' }).click();
    const terminal = window.getByTestId('terminal-host');
    await expect(terminal.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await terminal.click();
    await window.keyboard.type('echo km-shell-$((6*7))\n');
    await expect(terminal).toContainText('km-shell-42', { timeout: 30_000 });

    await window.getByRole('tab', { name: 'Network' }).click();
    await window.getByRole('textbox', { name: 'Local port' }).fill('38080');
    await window.getByRole('button', { name: 'Start' }).click();
    await expect(window.getByTestId('port-forward-status')).toContainText('Listening on 127.0.0.1:38080 → 8080', {
        timeout: 15_000,
    });

    // The forward outlives the page that started it, and the manager is where it is listed.
    await window.getByTestId('sidebar').getByRole('link', { name: 'Nodes', exact: true }).click();
    await window.getByRole('button', { name: 'Port forwards' }).click();
    const forwards = window.getByTestId('forward-list');
    await expect(
        forwards.locator('[data-forward="web-1"]').or(forwards.locator('[data-forward^="web-"]')),
    ).toContainText('127.0.0.1:38080');
    await forwards.getByRole('button', { name: /^Stop forward/ }).click();
    await expect(window.getByTestId('forward-list').locator('[data-forward]')).toHaveCount(0);
    await window.keyboard.press('Escape');
});

test('opens the command palette from the keyboard and jumps to a screen', async () => {
    const { window } = launched;
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const palette = window.getByRole('dialog', { name: 'Quick actions' });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('option', { name: 'km-e2e-ctx' })).toBeVisible();
    await palette.getByPlaceholder('Switch cluster, namespace or resource…').fill('nodes');
    await palette.getByRole('option', { name: 'Nodes', exact: true }).click();
    await expect(window.getByTestId('nodes-table')).toBeVisible();
    await expect(palette).toBeHidden();
});

test('opens Settings from the sidebar and switches the theme', async () => {
    const { window } = launched;
    await window
        .getByTestId('sidebar')
        .getByRole('link', { name: /Settings/ })
        .click();
    const page = window.getByTestId('settings-page');
    await expect(page).toContainText('Preferences for this Kubermeister install.');
    await expect(page.getByTestId('kubeconfig-path')).toContainText('.kubeconfig');
    await page.getByRole('radio', { name: /Light/ }).click();
    await expect(window.locator('html')).toHaveClass(/light/);
    await page.getByRole('radio', { name: /Dark/ }).click();
    await expect(window.locator('html')).toHaveClass(/dark/);
});

test('lists the seeded deployment and opens its rollout history', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Deployments' }).click();
    const row = window.getByTestId('deployments-table').locator('[data-deployment="web"]');
    await expect(row).toContainText('1/1');
    await expect(row).toContainText('Healthy');
    await expect(row).toContainText('busybox:1.36');
    await row.getByRole('link').click();
    const page = window.getByTestId('deployment-page');
    await expect(page).toContainText('namespace: km-e2e');
    await expect(page).toContainText('strategy: RollingUpdate');
    await window.getByRole('tab', { name: /History/ }).click();
    await expect(page.getByTestId('rollout-history')).toContainText('Current');
    await window.getByRole('tab', { name: /Replica Sets/ }).click();
    await expect(page.getByTestId('replica-sets').getByRole('row')).toHaveCount(2);
});

test('lists the seeded job and cron job and opens the job detail', async () => {
    const { window } = launched;
    // Exact: "Jobs" is a substring of "Cron Jobs", and both links sit in the sidebar.
    await window.getByTestId('sidebar').getByRole('link', { name: 'Jobs', exact: true }).click();
    const job = window.getByTestId('jobs-table').locator('[data-job="import"]');
    await expect(job).toContainText('1/1', { timeout: 30_000 });
    await expect(job).toContainText('Complete', { timeout: 30_000 });
    await job.getByRole('link').click();
    const page = window.getByTestId('job-page');
    await expect(page).toContainText('completions: 1/1');
    await expect(page).toContainText('Completions');

    await window.getByTestId('sidebar').getByRole('link', { name: 'Cron Jobs' }).click();
    const cron = window.getByTestId('cronjobs-table').locator('[data-cronjob="nightly"]');
    await expect(cron).toContainText('0 2 * * *');
    await expect(cron).toContainText('true');
});

test('shows config map entries and masks secret values', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Config Maps' }).click();
    await window.getByTestId('configmaps-table').locator('[data-configmap="app-config"]').getByRole('link').click();
    const configMap = window.getByTestId('configmap-page');
    await expect(configMap).toContainText('keys: 2');
    await window.getByRole('tab', { name: /Entries/ }).click();
    const entries = configMap.getByTestId('configmap-entries');
    await expect(entries).toContainText('LOG_LEVEL');
    await expect(entries).toContainText('debug');
    await expect(entries).toContainText('hello-from-e2e');

    await window.getByTestId('sidebar').getByRole('link', { name: 'Secrets' }).click();
    await window.getByTestId('secrets-table').locator('[data-secret="app-secret"]').getByRole('link').click();
    const secret = window.getByTestId('secret-page');
    await expect(secret).toContainText('type: Opaque');
    await window.getByRole('tab', { name: /Keys/ }).click();
    await expect(secret.getByTestId('secret-keys').getByRole('cell', { name: 'password' })).toBeVisible();
    await expect(window.getByText(/super-secret-value/)).toHaveCount(0);
});

test('shows the events stream, the namespace quota and its limit range', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Events stream' }).click();
    const events = window.getByTestId('events-table');
    await expect(events.getByRole('row')).not.toHaveCount(1, { timeout: 30_000 });
    await expect(events).toContainText('pod/');

    await window.getByTestId('sidebar').getByRole('link', { name: 'Quotas' }).click();
    const quotas = window.getByTestId('quotas-table');
    await expect(quotas).toContainText('team-quota');
    await expect(quotas).toContainText('requests.cpu');
    await expect(quotas.getByRole('progressbar').first()).toBeVisible();

    await window.getByTestId('sidebar').getByRole('link', { name: 'Limits' }).click();
    const limits = window.getByTestId('limits-table');
    await expect(limits).toContainText('team-limits');
    await expect(limits).toContainText('Container');
    await expect(limits).toContainText('500m');
});

test('lists the seeded service and opens its ports and endpoints', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Services', exact: true }).click();
    const row = window.getByTestId('services-table').locator('[data-service="web"]');
    await expect(row).toContainText('ClusterIP');
    await expect(row).toContainText('80/TCP');
    await row.getByRole('link').click();
    const page = window.getByTestId('service-page');
    await expect(page).toContainText('type: ClusterIP');
    await window.getByRole('tab', { name: /Ports/ }).click();
    await expect(page.getByTestId('service-ports')).toContainText('8080');
    await window.getByRole('tab', { name: /^Endpoints/ }).click();
    await expect(page.getByTestId('service-endpoints')).toContainText('Ready', { timeout: 30_000 });
    await window.getByRole('tab', { name: /Selector/ }).click();
    await expect(page).toContainText('app');
});

test('lists the default storage class and the seeded claim', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Storage Classes' }).click();
    const classes = window.getByTestId('storageclasses-table');
    await expect(classes.locator('[data-storageclass="local-path"]')).toContainText('default');
    await expect(classes).toContainText('rancher.io/local-path');

    await window.getByTestId('sidebar').getByRole('link', { name: 'Claims' }).click();
    const claim = window.getByTestId('claims-table').locator('[data-claim="data"]');
    // local-path binds on first use, so the claim may still be Pending here.
    await expect(claim).toContainText(/Pending|Bound/);
    await claim.getByRole('link').click();
    await expect(window.getByTestId('claim-page')).toContainText('namespace: km-e2e');

    await window.getByTestId('sidebar').getByRole('link', { name: 'Snapshots' }).click();
    await expect(window.getByText(/may not have the VolumeSnapshot CRD installed/)).toBeVisible();
});

test('lists the identity and role screens for the namespace and the cluster', async () => {
    const { window } = launched;
    const sidebar = window.getByTestId('sidebar');
    await sidebar.getByRole('link', { name: 'Service Accounts' }).click();
    // Every namespace gets a `default` service account, so it needs no seeding.
    await expect(window.getByTestId('serviceaccounts-table').locator('[data-serviceaccount="default"]')).toBeVisible();

    // "Roles" and "Role Bindings" are substrings of the cluster-scoped entries, so match exactly.
    await sidebar.getByRole('link', { name: 'Roles', exact: true }).click();
    const role = window.getByTestId('roles-table').locator('[data-role="reader"]');
    await expect(role).toContainText('2');
    await role.getByRole('link').click();
    await expect(window.getByTestId('role-page')).toContainText('rules: 2');

    await sidebar.getByRole('link', { name: 'Role Bindings', exact: true }).click();
    const binding = window.getByTestId('rolebindings-table').locator('[data-rolebinding="reader-binding"]');
    await expect(binding).toContainText('Role/reader');

    await sidebar.getByRole('link', { name: 'Cluster Roles', exact: true }).click();
    const clusterRole = window.getByTestId('clusterroles-table').locator('[data-clusterrole="cluster-admin"]');
    await clusterRole.getByRole('link').click();
    const page = window.getByTestId('clusterrole-page');
    // The rule count of the built-in role is the cluster's business; assert only that it has some.
    await expect(page).toContainText(/rules: [1-9]/);

    await sidebar.getByRole('link', { name: 'Cluster Role Bindings', exact: true }).click();
    await expect(
        window.getByTestId('clusterrolebindings-table').locator('[data-clusterrolebinding="cluster-admin"]'),
    ).toContainText('ClusterRole/cluster-admin');
});

test('lists the cluster definitions and the seeded helm release', async () => {
    const { window } = launched;
    const sidebar = window.getByTestId('sidebar');
    await sidebar.getByRole('link', { name: 'CRDs' }).click();
    // k3s ships its own Helm controller, so its definitions are always present.
    await expect(window.getByTestId('crds-table').locator('[data-crd="helmcharts.helm.cattle.io"]')).toContainText(
        'HelmChart',
    );

    await sidebar.getByRole('link', { name: 'Releases' }).click();
    const release = window.getByTestId('releases-table').locator('[data-release="demo"]');
    await expect(release).toContainText('Deployed');
    // Two revision Secrets exist; the list shows the current one only.
    await expect(release).toContainText('demo-1.2.3');
    await release.getByRole('link').click();
    const page = window.getByTestId('release-page');
    await expect(page).toContainText('chart: demo-1.2.3');
    await expect(page.getByTestId('release-revisions')).toContainText('Install complete');
    await window.getByRole('tab', { name: /Values/ }).click();
    await expect(page.getByTestId('release-values')).toContainText('replicaCount: 2');

    await sidebar.getByRole('link', { name: 'Helm charts' }).click();
    await expect(window.getByTestId('charts-table').locator('[data-chart="demo"]')).toContainText('3.0.0');
});

test('shows the live manifest of a pod and of a cluster-scoped object', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Pods' }).click();
    await window.getByTestId('pods-table').locator('[data-pod^="web-"]').first().getByRole('link').click();
    const pod = window.getByTestId('pod-page');
    await window.getByRole('tab', { name: /Manifest/ }).click();
    const manifest = pod.getByTestId('manifest-panel');
    await expect(manifest).toContainText('kind: Pod');
    await expect(manifest).toContainText('apiVersion: v1');
    // The serializer keeps the fields a writer needs and drops the server's bookkeeping.
    await expect(manifest).toContainText('resourceVersion');
    await expect(manifest).not.toContainText('managedFields');

    await window.getByTestId('sidebar').getByRole('link', { name: 'Storage Classes' }).click();
    await window
        .getByTestId('storageclasses-table')
        .locator('[data-storageclass="local-path"]')
        .getByRole('link')
        .click();
    await window.getByRole('tab', { name: /Manifest/ }).click();
    await expect(window.getByTestId('storageclass-page').getByTestId('manifest-panel')).toContainText(
        'kind: StorageClass',
    );
});

test('creates a config map from the editor, scales the deployment, then deletes what it made', async () => {
    const { window } = launched;
    await window.getByRole('link', { name: 'Create resource' }).click();
    const create = window.getByTestId('create-page');
    await expect(create).toContainText(`/ ${NAMESPACE}`);
    await create.getByRole('combobox', { name: 'Insert template' }).click();
    await window.getByRole('option', { name: /ConfigMap/ }).click();
    await create.getByRole('button', { name: 'Dry run' }).click();
    await expect(window.getByText('Dry run passed')).toBeVisible();
    await create.getByRole('button', { name: 'Create' }).click();

    // A successful create lands on the kind's own list.
    const table = window.getByTestId('configmaps-table');
    await expect(table.locator('[data-configmap="my-config"]')).toBeVisible();

    // Scaling writes an absolute target, so the row shows the new count once the cluster agrees.
    await window.getByTestId('sidebar').getByRole('link', { name: 'Deployments' }).click();
    const web = window.getByTestId('deployments-table').locator('[data-deployment="web"]');
    await web.getByRole('button', { name: 'Scale up' }).click();
    await expect(window.getByText(/Scaled Deployment/)).toBeVisible();
    await expect(web).toContainText('2', { timeout: 30_000 });
    await web.getByRole('button', { name: 'Scale down' }).click();

    await window.getByTestId('sidebar').getByRole('link', { name: 'Config Maps' }).click();
    await window.getByTestId('configmaps-table').locator('[data-configmap="my-config"]').getByRole('link').click();
    await window.getByTestId('configmap-page').getByRole('button', { name: 'Delete' }).click();
    const dialog = window.getByRole('alertdialog');
    await expect(dialog).toContainText('Delete ConfigMap?');
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(window.getByTestId('configmaps-table').locator('[data-configmap="my-config"]')).toHaveCount(0);
});

test('restarts the seeded deployment, which rolls its pods onto a new replica set', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Deployments' }).click();
    await window.getByTestId('deployments-table').locator('[data-deployment="web"]').getByRole('link').click();
    const page = window.getByTestId('deployment-page');
    await page.getByRole('button', { name: 'Restart' }).click();
    const dialog = window.getByRole('alertdialog');
    await expect(dialog).toContainText('Restart Deployment?');
    await dialog.getByRole('button', { name: 'Restart' }).click();
    await expect(window.getByText(/restarting/)).toBeVisible();

    // The stamped template makes the controller roll the pods onto a second replica set. How many
    // sets exist at any moment depends on how far the roll has got, so this waits for more than one.
    await page.getByRole('tab', { name: /Replica Sets/ }).click();
    const sets = page.getByTestId('replica-sets');
    await expect(sets).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => sets.getByRole('row').count(), { timeout: 30_000 }).toBeGreaterThan(2);
    await window.getByRole('tab', { name: /History/ }).click();
    await expect(page.getByTestId('rollout-history').locator('[data-revision="2"]')).toBeVisible();
});

test('pauses, resumes and rolls the seeded deployment back to its first revision', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Deployments' }).click();
    await window.getByTestId('deployments-table').locator('[data-deployment="web"]').getByRole('link').click();
    const page = window.getByTestId('deployment-page');

    // The rollout picture is live: the generation the deployment points at is marked as the new one.
    await window.getByRole('tab', { name: 'Status' }).click();
    await expect(page.getByTestId('rollout-generations')).toContainText('New');

    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(window.getByText(/Rollout of .* paused/)).toBeVisible();
    await expect(page.getByTestId('rollout-progress')).toContainText('Paused', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 30_000 });

    // Rolling back restores revision 1's template, which the cluster records as a new revision: the
    // restart spec above left revision 2 current, so undoing it lands as revision 3.
    await window.getByRole('tab', { name: /History/ }).click();
    const history = page.getByTestId('rollout-history');
    await history.locator('[data-revision="1"]').getByRole('button', { name: 'Roll back' }).click();
    const dialog = window.getByRole('alertdialog');
    await expect(dialog).toContainText('Roll back to revision #1?');
    await dialog.getByRole('button', { name: 'Roll back' }).click();
    await expect(window.getByText(/Rolled .* back to revision #1/)).toBeVisible();
    await expect(history.locator('[data-revision="3"]')).toContainText('Current', { timeout: 30_000 });
});

test('cordons the node, reads what a drain would move, and uncordons it again', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Nodes', exact: true }).click();
    await window.getByTestId('nodes-table').getByRole('link').first().click();
    const page = window.getByTestId('node-page');
    await expect(page.getByRole('button', { name: 'Cordon' })).toBeVisible();

    await page.getByRole('button', { name: 'Cordon' }).click();
    await expect(window.getByText(/cordoned/)).toBeVisible();
    // The cordon is real: the node reads as cordoned and the control offers the way back.
    await expect(page.getByRole('button', { name: 'Uncordon' })).toBeVisible({ timeout: 30_000 });

    // The plan is a read, so it says what a drain would do without moving anything.
    await page.getByRole('button', { name: 'Drain' }).click();
    const plan = window.getByTestId('drain-plan');
    await expect(plan).toContainText('to evict');
    await expect(plan).toContainText('left alone');
    await window.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Uncordon' }).click();
    await expect(page.getByRole('button', { name: 'Cordon' })).toBeVisible({ timeout: 30_000 });
});

test('rolls the seeded release back to its first revision, then uninstalls it', async () => {
    const { window } = launched;
    // Revision 2 rendered an extra ConfigMap; revision 1 never had it.
    await window.getByTestId('sidebar').getByRole('link', { name: 'Config Maps' }).click();
    await expect(window.getByTestId('configmaps-table').locator('[data-configmap="demo-extra"]')).toBeVisible();

    await window.getByTestId('sidebar').getByRole('link', { name: 'Releases' }).click();
    await window.getByTestId('releases-table').locator('[data-release="demo"]').getByRole('link').click();
    const page = window.getByTestId('release-page');
    await window.getByRole('tab', { name: /Revisions/ }).click();
    const history = page.getByTestId('release-revisions');
    await history.locator('[data-revision="1"]').getByRole('button', { name: 'Roll back' }).click();
    const dialog = window.getByRole('alertdialog');
    await expect(dialog).toContainText('Roll back to revision 1?');
    await dialog.getByRole('button', { name: 'Roll back' }).click();
    await expect(window.getByText(/Rolled/)).toBeVisible();

    // Helm numbers forward: the rollback lands as revision 3, running revision 1's manifest.
    await expect(history.locator('[data-revision="3"]')).toContainText('Deployed', { timeout: 30_000 });
    await window.getByTestId('sidebar').getByRole('link', { name: 'Config Maps' }).click();
    await expect(window.getByTestId('configmaps-table').locator('[data-configmap="demo-extra"]')).toHaveCount(0, {
        timeout: 30_000,
    });

    await window.getByTestId('sidebar').getByRole('link', { name: 'Releases' }).click();
    await window.getByTestId('releases-table').locator('[data-release="demo"]').getByRole('link').click();
    await page.getByRole('button', { name: 'Uninstall' }).click();
    await window.getByRole('alertdialog').getByRole('button', { name: 'Uninstall' }).click();
    await expect(window.getByText(/uninstalled/)).toBeVisible();
    await expect(window.getByTestId('releases-table').locator('[data-release="demo"]')).toHaveCount(0, {
        timeout: 30_000,
    });
});

test('links a pod to the workload that runs it, and lists that workload’s pods', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Deployments' }).click();
    await window.getByTestId('deployments-table').locator('[data-deployment="web"]').getByRole('link').click();
    const deployment = window.getByTestId('deployment-page');
    await window.getByRole('tab', { name: 'Pods' }).click();
    // The exact count moves while earlier specs' rollouts settle; what matters is that the
    // deployment's own pods are the ones listed.
    const owned = deployment.getByTestId('owned-pods');
    await expect(owned.locator('[data-pod]').first()).toBeVisible({ timeout: 30_000 });
    await expect(owned.locator('[data-pod^="web-"]').first()).toBeVisible();

    // Following a pod from its workload and back up the chain lands on the same deployment.
    await owned.getByRole('link').first().click();
    const pod = window.getByTestId('pod-page');
    const chain = pod.getByTestId('owner-chain');
    await expect(chain).toContainText('ReplicaSet');
    // The chain links the replica set too, whose name starts with the deployment's own.
    await chain.getByRole('link', { name: 'web', exact: true }).click();
    await expect(window.getByTestId('deployment-page')).toContainText('namespace: km-e2e');
});

test('runs the seeded cron job now, suspends its schedule, and evicts a pod', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Cron Jobs' }).click();
    await window.getByTestId('cronjobs-table').locator('[data-cronjob="nightly"]').getByRole('link').click();
    const page = window.getByTestId('cronjob-page');

    // The seed suspends this schedule, so the control offers the way back first.
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(window.getByText(/resumed/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Suspend' })).toBeVisible({ timeout: 30_000 });

    // Running it now creates a job off the schedule, which the jobs list shows.
    await page.getByRole('button', { name: 'Run now' }).click();
    await expect(window.getByText(/created/)).toBeVisible();
    await window.getByTestId('sidebar').getByRole('link', { name: 'Jobs', exact: true }).click();
    await expect(window.getByTestId('jobs-table').locator('[data-job^="nightly-"]')).toBeVisible({ timeout: 30_000 });

    // Evicting a pod goes through the eviction API, so nothing here can bypass a disruption budget.
    await window.getByTestId('sidebar').getByRole('link', { name: 'Pods' }).click();
    const pod = window.getByTestId('pods-table').locator('[data-pod^="web-"]').first();
    await pod.getByRole('link').click();
    await window.getByTestId('pod-page').getByRole('button', { name: 'Evict' }).click();
    const dialog = window.getByRole('alertdialog');
    await expect(dialog).toContainText('disruption budget may refuse it');
    await dialog.getByRole('button', { name: 'Evict' }).click();
    await expect(window.getByText(/evicted/)).toBeVisible();
});

test('shows a container’s usage against its request and edits the autoscaler bounds', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Pods' }).click();
    await window.getByTestId('pods-table').locator('[data-pod^="web-"]').first().getByRole('link').click();
    const containers = window.getByTestId('pod-page').getByTestId('containers');
    // The seeded container asks for CPU, so its row states usage against that request.
    await expect(containers.locator('[data-usage="CPU"]').first()).toBeVisible();

    await window.getByTestId('sidebar').getByRole('link', { name: 'Autoscalers' }).click();
    await window.getByTestId('autoscalers-table').locator('[data-autoscaler="web"]').getByRole('link').click();
    const page = window.getByTestId('autoscaler-page');
    await page.getByRole('button', { name: 'Edit bounds' }).click();
    const bounds = window.getByTestId('autoscaler-bounds');
    await bounds.getByLabel('Maximum replicas').fill('4');
    await bounds.getByRole('button', { name: 'Save' }).click();
    await expect(window.getByText(/updated/)).toBeVisible();
    // The details grid puts the label and its value in adjacent cells, so the text reads "Max4".
    await expect(page).toContainText('Max4', { timeout: 30_000 });
});

test('describes a pod and a node in the flat view', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Pods' }).click();
    await window.getByTestId('pods-table').locator('[data-pod^="web-"]').first().getByRole('link').click();
    await window.getByRole('tab', { name: 'Describe' }).click();
    const podDescribe = window.getByTestId('pod-page').getByTestId('describe');
    await expect(podDescribe.locator('[data-section="Overview"]')).toContainText('km-e2e');
    // Every container gets its own block, named after the container.
    await expect(podDescribe.locator('[data-section="Containers"] [data-block]').first()).toBeVisible();

    await window.getByTestId('sidebar').getByRole('link', { name: 'Nodes', exact: true }).click();
    await window.getByTestId('nodes-table').getByRole('link').first().click();
    await window.getByRole('tab', { name: 'Describe' }).click();
    const nodeDescribe = window.getByTestId('node-page').getByTestId('describe');
    await expect(nodeDescribe.locator('[data-section="Capacity"]')).toContainText('cpu');
    await expect(nodeDescribe.locator('[data-section="Pods"]')).toContainText('km-e2e/');
});

test('follows every pod of the seeded deployment in one view', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Deployments' }).click();
    await window.getByTestId('deployments-table').locator('[data-deployment="web"]').getByRole('link').click();
    const page = window.getByTestId('deployment-page');
    await window.getByRole('tab', { name: 'Logs' }).click();

    // The picker names how many pods are being followed rather than a container.
    const viewer = page.getByTestId('log-viewer');
    await expect(viewer.getByRole('button', { name: 'Container' })).toContainText('pods', { timeout: 30_000 });
    await viewer.getByRole('button', { name: 'Live' }).click();
    // Each line carries the pod it came from, which is the point of the view.
    await expect(viewer.getByRole('list', { name: 'Log lines' })).toContainText('km-e2e-marker', { timeout: 60_000 });
    await expect(viewer.getByRole('list', { name: 'Log lines' }).locator('[title^="web-"]').first()).toBeVisible();
});

test('forwards a service, which resolves to whichever pod is ready', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Services', exact: true }).click();
    await window.getByTestId('services-table').locator('[data-service="web"]').getByRole('link').click();
    const page = window.getByTestId('service-page');
    // The forward control sits with the ports it forwards.
    await window.getByRole('tab', { name: 'Ports' }).click();
    await page.getByRole('textbox', { name: 'Local port' }).fill('38081');
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByTestId('port-forward-status')).toContainText('Listening on 127.0.0.1:38081', {
        timeout: 15_000,
    });

    // It is remembered, so it is offered again after being stopped.
    await window.getByRole('button', { name: 'Port forwards' }).click();
    const forwards = window.getByTestId('forward-list');
    await forwards.getByRole('button', { name: /^Stop forward/ }).click();
    await expect(forwards.locator('[data-remembered="web"]')).toBeVisible({ timeout: 30_000 });
    await window.keyboard.press('Escape');
});

test('lists the replica set behind the deployment, the budget over it, and the cluster plumbing', async () => {
    const { window } = launched;
    const sidebar = window.getByTestId('sidebar');

    await sidebar.getByRole('link', { name: 'Replica Sets' }).click();
    const sets = window.getByTestId('replicasets-table');
    // The deployment's own replica set is named by its hash, so it is found by its owner instead.
    const set = sets.locator('tbody tr', { hasText: 'Deployment/web' }).first();
    await expect(set).toContainText('busybox:1.36');
    await set.getByRole('link').click();
    await expect(window.getByTestId('replicaset-page')).toContainText('owner: Deployment/web');

    // Nothing seeds a replication controller: the screen says so rather than failing to load.
    await sidebar.getByRole('link', { name: 'Replication Controllers' }).click();
    await expect(window.getByText('No Replication Controllers found.')).toBeVisible();

    await sidebar.getByRole('link', { name: 'Disruption Budgets' }).click();
    const budget = window.getByTestId('disruptionbudgets-table').locator('[data-disruptionbudget="web"]');
    await expect(budget).toContainText('min available 2');
    // Nothing healthy matches its selector, so it allows no disruption at all.
    await expect(budget).toContainText('Blocked');
    await budget.getByRole('link').click();
    await expect(window.getByTestId('disruptionbudget-page')).toContainText('allowed: 0');

    await sidebar.getByRole('link', { name: 'Priority Classes' }).click();
    const priority = window.getByTestId('priorityclasses-table').locator('[data-priorityclass="km-e2e-high"]');
    await expect(priority).toContainText('1000');
    await priority.getByRole('link').click();
    await expect(window.getByTestId('priorityclass-page')).toContainText('preemption: PreemptLowerPriority');

    // "Leases" is a substring of "Releases", so match the whole label.
    await sidebar.getByRole('link', { name: 'Leases', exact: true }).click();
    const lease = window.getByTestId('leases-table').locator('[data-lease="km-e2e-leader"]');
    await expect(lease).toContainText('km-e2e-1');
    await lease.getByRole('link').click();
    await expect(window.getByTestId('lease-page')).toContainText('holder: km-e2e-1');

    // Leave the app on a list, since the specs after this one start from wherever this one stopped.
    await sidebar.getByRole('link', { name: 'Pods' }).click();
});

test('lists the class kinds and the CSI plumbing behind the volumes', async () => {
    const { window } = launched;
    const sidebar = window.getByTestId('sidebar');

    await sidebar.getByRole('link', { name: 'Runtime Classes' }).click();
    const runtime = window.getByTestId('runtimeclasses-table').locator('[data-runtimeclass="km-e2e-runtime"]');
    await expect(runtime).toContainText('runc');
    await runtime.getByRole('link').click();
    await expect(window.getByTestId('runtimeclass-page')).toContainText('handler: runc');

    await sidebar.getByRole('link', { name: 'Ingress Classes' }).click();
    const ingress = window.getByTestId('ingressclasses-table').locator('[data-ingressclass="km-e2e-ingress"]');
    await expect(ingress).toContainText('example.com/km-e2e');
    await expect(ingress).toContainText('default');
    await ingress.getByRole('link').click();
    await expect(window.getByTestId('ingressclass-page')).toContainText('controller: example.com/km-e2e');

    // k3s registers no CSI driver, so both driver screens show what an empty list looks like.
    await sidebar.getByRole('link', { name: 'CSI Drivers' }).click();
    await expect(window.getByText('No CSI Drivers found.')).toBeVisible();
    await sidebar.getByRole('link', { name: 'CSI Nodes' }).click();
    await expect(window.getByRole('heading', { name: 'CSI Nodes' })).toBeVisible();

    await sidebar.getByRole('link', { name: 'Storage Capacity' }).click();
    const capacity = window.getByTestId('capacity-table').locator('[data-capacity="km-e2e-capacity"]');
    await expect(capacity).toContainText('local-path');
    await expect(capacity).toContainText('10Gi');
    await capacity.getByRole('link').click();
    await expect(window.getByTestId('capacity-page')).toContainText('class: local-path');

    // Leave the app on a list, since the specs after this one start from wherever this one stopped.
    await sidebar.getByRole('link', { name: 'Pods' }).click();
});

test('lists what stands between a write and the cluster, and the API server’s own extensions', async () => {
    const { window } = launched;
    const sidebar = window.getByTestId('sidebar');

    await sidebar.getByRole('link', { name: 'Mutating Webhooks' }).click();
    const mutating = window.getByTestId('mutatingwebhooks-table').locator('[data-mutatingwebhook="km-e2e-mutating"]');
    await expect(mutating).toContainText('mutate.km-e2e.test');
    // The seeded hooks fail open, so they are reported as harmless rather than as a dependency.
    await expect(mutating).toContainText('Permissive');
    await mutating.getByRole('link').click();
    await expect(window.getByTestId('mutatingwebhook-page')).toContainText('webhooks: 1');

    await sidebar.getByRole('link', { name: 'Validating Webhooks' }).click();
    const validating = window
        .getByTestId('validatingwebhooks-table')
        .locator('[data-validatingwebhook="km-e2e-validating"]');
    await expect(validating).toContainText('Ignore');

    await sidebar.getByRole('link', { name: 'Admission Policies' }).click();
    const policy = window.getByTestId('admissionpolicies-table').locator('[data-admissionpolicy="km-e2e-policy"]');
    await expect(policy).toContainText('apps/deployments');
    await policy.getByRole('link').click();
    await expect(window.getByTestId('admissionpolicy-page')).toContainText('validations: 1');

    // These two need no seeding: every API server serves its own core API and its own flow schemas.
    await sidebar.getByRole('link', { name: 'API Services' }).click();
    const core = window.getByTestId('apiservices-table').locator('[data-apiservice="v1."]');
    await expect(core).toContainText('Local');
    await expect(core).toContainText('Available');

    await sidebar.getByRole('link', { name: 'Flow Schemas' }).click();
    await expect(window.getByTestId('flowschemas-table').locator('[data-flowschema="exempt"]')).toBeVisible();

    // Leave the app on a list, since the specs after this one start from wherever this one stopped.
    await sidebar.getByRole('link', { name: 'Pods' }).click();
});

test('browses the instances of a definition through the columns it declares', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'CRDs' }).click();
    await window.getByTestId('crds-table').locator('[data-crd="widgets.km-e2e.test"]').getByRole('link').click();
    await window.getByTestId('crd-page').getByRole('link', { name: 'View instances' }).click();

    const table = window.getByTestId('instances-table');
    // The columns are the definition's own additionalPrinterColumns, plus Name and Age.
    await expect(table.getByRole('columnheader', { name: 'Size' })).toBeVisible();
    const instance = table.locator('[data-instance="left"]');
    await expect(instance).toContainText('large');
    // Nothing sets the status, so the declared column reads as absent rather than as false.
    await expect(instance).toContainText('—');

    await instance.getByRole('link').click();
    const page = window.getByTestId('instance-page');
    await expect(page).toContainText('large');
    await page.getByRole('tab', { name: /Manifest/ }).click();
    await expect(page).toContainText('kind: Widget');

    await window.getByTestId('sidebar').getByRole('link', { name: 'Pods' }).click();
});

test('opens a namespace, reads what is in it, and groups the pod list by node', async () => {
    const { window } = launched;
    const sidebar = window.getByTestId('sidebar');
    await sidebar.getByRole('link', { name: 'Namespaces' }).click();
    await window.getByTestId('namespaces-table').locator('[data-namespace="km-e2e"]').getByRole('link').click();

    const page = window.getByTestId('namespace-page');
    await expect(page).toContainText('phase: Active');
    await page.getByRole('tab', { name: 'Contents' }).click();
    const counts = page.getByTestId('namespace-counts');
    // The seeded namespace holds at least the deployment's pod and the config map beside it.
    await expect(counts.locator('[data-count="Pod"]')).toBeVisible();
    await expect(counts.locator('[data-count="ConfigMap"]')).toBeVisible();

    await page.getByRole('tab', { name: 'Budgets' }).click();
    // The seed carries a quota and a limit range for this namespace.
    await expect(page.getByTestId('namespace-quotas')).toContainText('pods');
    await expect(page.getByTestId('namespace-limits')).toContainText('cpu');

    // A namespace created here is a real namespace, and the list picks it up.
    await sidebar.getByRole('link', { name: 'Namespaces' }).click();
    await window.getByTestId('create-namespace').click();
    const dialog = window.getByRole('alertdialog');
    await dialog.getByLabel('Namespace name').fill('km-e2e-made');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(window.getByTestId('namespaces-table').locator('[data-namespace="km-e2e-made"]')).toBeVisible({
        timeout: 30_000,
    });

    // Grouping turns a wall of pod names into what runs where.
    await sidebar.getByRole('link', { name: 'Pods' }).click();
    await window.getByRole('combobox', { name: 'Group pods' }).click();
    await window.getByRole('option', { name: 'By node' }).click();
    await expect(window.getByTestId('pods-table').locator('[data-group]').first()).toBeVisible();
    await window.getByRole('combobox', { name: 'Group pods' }).click();
    await window.getByRole('option', { name: 'No grouping' }).click();
});

test('reads the owner and finalizers of an object', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Pods' }).click();
    const table = window.getByTestId('pods-table');
    await expect(table.locator('[data-pod^="web-"]').first()).toBeVisible();

    // Every detail carries the owner reference and the finalizers, read through one channel.
    await table.locator('[data-pod^="web-"]').first().getByRole('link').click();
    const page = window.getByTestId('pod-page');
    await page.getByRole('tab', { name: /Labels/ }).click();
    const card = page.getByTestId('object-meta');
    await expect(card).toContainText('ReplicaSet/web-');
    await expect(card).toContainText('T');
});

test('compares two revisions of the seeded deployment', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Deployments' }).click();
    await window.getByTestId('deployments-table').locator('[data-deployment="web"]').getByRole('link').click();
    const page = window.getByTestId('deployment-page');

    // A second revision of its own, so this spec does not depend on what earlier ones left behind.
    await page.getByRole('button', { name: 'Restart' }).click();
    await window.getByRole('alertdialog').getByRole('button', { name: 'Restart' }).click();
    await page.getByRole('tab', { name: /History/ }).click();
    await expect(page.getByTestId('rollout-history').locator('[data-revision="2"]')).toBeVisible({ timeout: 30_000 });

    const diff = page.getByTestId('revision-diff');
    await expect(diff).toBeVisible({ timeout: 30_000 });
    // A restart changes exactly one thing in the template, and that is what the diff shows.
    // A restart writes the stamp annotation, so the two newest revisions differ by it — added when
    // the older one had none, and a changed value when an earlier spec already restarted this one.
    // Whichever way round the two newest revisions sit — a restart that added the stamp, or a
    // rollback to a template that never had one — the difference between them is that annotation.
    await expect(diff).toContainText('restartedAt');
    await expect(diff.locator('[data-diff="added"], [data-diff="removed"]').first()).toBeVisible();
});

test('shows what else a pod is tied to, and why', async () => {
    const { window } = launched;
    await window.getByTestId('sidebar').getByRole('link', { name: 'Pods' }).click();
    await window.getByTestId('pods-table').locator('[data-pod^="web-"]').first().getByRole('link').click();
    const page = window.getByTestId('pod-page');
    await page.getByRole('tab', { name: 'Related' }).click();

    // The seeded service selects app=web, so it is a relation the app can explain.
    const traffic = page.getByTestId('related-traffic');
    await expect(traffic.locator('[data-related="web"]')).toContainText('selects these pods');
    // Every pod runs as some service account, even the default one.
    await expect(page.getByTestId('related-access')).toContainText('runs as');
});

test('opens the shell with a connection notice when the kubeconfig path names nothing', async () => {
    const missing = join(tmpdir(), `km-e2e-missing-${Date.now()}.yaml`);
    const bad = await launchApp({ kubeconfigPath: missing });
    try {
        // The shell is not held back: only cluster calls depend on the kubeconfig.
        await bad.window.getByTestId('app-shell').waitFor();
        const notice = bad.window.getByTestId('connection-notice');
        await expect(notice).toContainText('Kubeconfig not loaded');
        await notice.click();
        await expect(bad.window.getByText('Fix or clear the kubeconfig path in Settings.')).toBeVisible();
        await expect(bad.window.getByRole('button', { name: 'Use default kubeconfig' })).toBeVisible();
        await bad.window.keyboard.press('Escape');
        // Settings, where the path is fixed, is reachable; so is everything else that needs no cluster.
        await bad.window
            .getByTestId('sidebar')
            .getByRole('link', { name: /Settings/ })
            .click();
        await expect(bad.window.getByTestId('settings-page').getByTestId('kubeconfig-path')).toContainText(
            'km-e2e-missing',
        );
        await expect(bad.window.getByTestId('startup-error')).toHaveCount(0);
    } finally {
        await bad.app.close();
    }
});
