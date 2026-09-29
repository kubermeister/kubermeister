import { expect, test } from '@playwright/test';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_NAME, KUBECONFIG_PATH, NAMESPACE, clusterKubectl } from '../harness/cluster';
import { closeApp, launchApp, type LaunchedApp } from '../harness/launch';

// The second half of app.test.ts, starting at the specs that act on the seeded objects, split off so
// CI runs the two on separate clusters at once (the projects in playwright.config.ts). Specs here
// still run in order and some build on the one above (the rollback undoes the restart before it), so
// a spec moves to another file only together with what it depends on.
let launched: LaunchedApp;

test.beforeEach(async () => {
    launched = await launchApp();
});

test.afterEach(async () => {
    await closeApp(launched);
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

    // A field another manager sets on a release's object: a replace would drop it, an apply keeps it.
    clusterKubectl(['-n', NAMESPACE, 'annotate', 'configmap', 'demo-config', 'km-e2e.test/note=set-by-kubectl']);

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

    // The rollback applied revision 1's colour server-side as helm, and kubectl's annotation is still
    // there, since another manager owns it and the render leaves it out.
    const applied = clusterKubectl([
        '-n',
        NAMESPACE,
        'get',
        'configmap',
        'demo-config',
        '-o',
        String.raw`jsonpath={.data.colour} {.metadata.annotations.km-e2e\.test/note}`,
    ]);
    expect(applied).toBe('blue set-by-kubectl');

    // The seed applied demo-config without Helm's ownership metadata, so the rollback's apply is what
    // stamps it, as Helm stamps every object it writes.
    const owner = clusterKubectl([
        '-n',
        NAMESPACE,
        'get',
        'configmap',
        'demo-config',
        '-o',
        String.raw`jsonpath={.metadata.labels.app\.kubernetes\.io/managed-by} {.metadata.annotations.meta\.helm\.sh/release-name} {.metadata.annotations.meta\.helm\.sh/release-namespace}`,
    ]);
    expect(owner).toBe(`Helm demo ${NAMESPACE}`);

    // The Helm CLI deletes only objects carrying that metadata and leaves the rest as "not owned by
    // this release", so it uninstalling the rolled-back release cleanly is the proof. It keeps the
    // history, which leaves the app's own uninstall below something to forget.
    const helmHome = mkdtempSync(join(tmpdir(), 'km-e2e-helm-'));
    try {
        const uninstalled = execFileSync(
            'helm',
            ['uninstall', 'demo', '--namespace', NAMESPACE, '--keep-history', '--wait', '--timeout', '60s'],
            {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { PATH: process.env.PATH, HOME: helmHome, KUBECONFIG: KUBECONFIG_PATH },
            },
        );
        expect(uninstalled).not.toContain('not owned by this release');
    } finally {
        rmSync(helmHome, { recursive: true, force: true });
    }
    expect(clusterKubectl(['-n', NAMESPACE, 'get', 'configmap', 'demo-config', '--ignore-not-found'])).toBe('');

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
    // Every pod is followed from the moment the tab opens; each line carries the one it came from,
    // which is the point of the view.
    await expect(viewer).toHaveAttribute('data-live', 'true');
    await expect(viewer.getByRole('list', { name: 'Log lines' })).toContainText('km-e2e-marker', { timeout: 60_000 });
    // Named in full, never cut short: a deployment's pods differ only in the suffix.
    const podCell = viewer.getByRole('list', { name: 'Log lines' }).locator('[data-pod^="web-"]').first();
    await expect(podCell).toBeVisible();
    expect(await podCell.textContent()).toBe(await podCell.getAttribute('data-pod'));
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

test('names a current context whose cluster is missing, and switching away clears it', async () => {
    // The seeded kubeconfig, plus a context whose cluster entry is not there, made current.
    const seeded = loadYaml(readFileSync(KUBECONFIG_PATH, 'utf8')) as {
        contexts: unknown[];
        'current-context': string;
    };
    seeded.contexts.push({ name: 'nowhere', context: { cluster: 'gone', user: 'gone' } });
    seeded['current-context'] = 'nowhere';
    const broken = join(tmpdir(), `km-e2e-broken-context-${Date.now()}.yaml`);
    writeFileSync(broken, dumpYaml(seeded));
    const bad = await launchApp({ kubeconfigPath: broken, restoreContext: false });
    try {
        await bad.window.getByTestId('app-shell').waitFor();
        const notice = bad.window.getByTestId('connection-notice');
        await expect(notice).toContainText('Context unusable');
        await notice.click();
        await expect(bad.window.getByRole('dialog').getByText(/names cluster "gone"/)).toBeVisible();
        // Every screen says the same thing instead of "Something went wrong".
        await expect(bad.window.getByTestId('dashboard-error')).toContainText('Kubeconfig not loaded');
        await bad.window.keyboard.press('Escape');
        // The selector beside it is the fix: the whole context is listed and the broken one is marked.
        await bad.window.getByTestId('context-selector').click();
        const menu = bad.window.getByRole('menu');
        await expect(menu.getByRole('menuitem', { name: /nowhere/ })).toContainText('Unusable');
        await menu.getByRole('menuitem', { name: new RegExp(CONTEXT_NAME) }).click();
        await expect(bad.window.getByTestId('connection-notice')).toHaveCount(0);
        await expect(bad.window.getByTestId('context-selector')).toContainText(CONTEXT_NAME);
    } finally {
        await closeApp(bad);
    }
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
        await closeApp(bad);
    }
});
