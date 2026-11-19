import { expect, test } from '@playwright/test';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_NAME, KUBECONFIG_PATH, NAMESPACE, clusterKubectl } from '../harness/cluster';
import { closeApp, launchApp, type LaunchedApp } from '../harness/launch';

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
    if (launched) await closeApp(launched);
    launched = undefined;
});

/**
 * A kubeconfig for a service account that may read pods and events inside the seeded namespace and
 * nothing cluster-wide: it may not list namespaces, which is the account this spec is about.
 */
function restrictedKubeconfig(): string {
    const account = 'km-e2e-restricted';
    const manifest = dumpYaml({
        apiVersion: 'v1',
        kind: 'List',
        items: [
            { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: account, namespace: NAMESPACE } },
            {
                apiVersion: 'rbac.authorization.k8s.io/v1',
                kind: 'Role',
                metadata: { name: account, namespace: NAMESPACE },
                rules: [{ apiGroups: [''], resources: ['pods', 'events'], verbs: ['get', 'list', 'watch'] }],
            },
            {
                apiVersion: 'rbac.authorization.k8s.io/v1',
                kind: 'RoleBinding',
                metadata: { name: account, namespace: NAMESPACE },
                roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: account },
                subjects: [{ kind: 'ServiceAccount', name: account, namespace: NAMESPACE }],
            },
        ],
    });
    // Applied rather than created, so a kept cluster that already has them from an earlier run is fine.
    clusterKubectl(['apply', '-f', '-'], manifest);
    const token = clusterKubectl(['-n', NAMESPACE, 'create', 'token', account]).trim();
    const seeded = loadYaml(readFileSync(KUBECONFIG_PATH, 'utf8')) as { users: { user: Record<string, string> }[] };
    seeded.users[0]!.user = { token };
    const path = join(tmpdir(), `km-e2e-restricted-${Date.now()}.yaml`);
    writeFileSync(path, dumpYaml(seeded));
    return path;
}

test('an account that may not list namespaces types one and reads it', async () => {
    launched = await launchApp({
        kubeconfigPath: restrictedKubeconfig(),
        // No namespace to start from: neither the context nor the session names one.
        settings: { session: { lastContext: CONTEXT_NAME, lastNamespace: null, restoreOnLaunch: true } },
    });
    const { window } = launched;
    await window.getByTestId('app-shell').waitFor();
    await expect(window.getByTestId('active-namespace')).toHaveText('All namespaces');

    // Cluster-wide, everything is refused, and the summary says where the way out is.
    const refusedSummary = window.getByTestId('dashboard-error');
    await expect(refusedSummary).toContainText('Access denied');
    await expect(refusedSummary.getByTestId('forbidden-namespace-hint')).toBeVisible();

    // The selector says the list was refused rather than showing an empty one, and takes a typed name.
    await window.getByTestId('namespace-selector').click();
    await expect(window.getByTestId('namespaces-refused')).toContainText('Access denied');
    await window.getByPlaceholder('Type a namespace…').fill(NAMESPACE);
    await window.getByRole('option', { name: `Use “${NAMESPACE}”` }).click();
    await expect(window.getByTestId('active-namespace')).toHaveText(NAMESPACE);

    // The summary now reads that namespace's events instead of failing whole.
    await expect(window.getByTestId('dashboard-metrics')).toBeVisible();
    await expect(window.getByTestId('recent-events')).toBeVisible();

    // And a namespaced list reads the namespace the account is allowed in.
    await window.getByTestId('sidebar').getByRole('link', { name: 'Pods' }).click();
    await expect(window.getByTestId('pods-table').locator('[data-pod^="web-"]').first()).toBeVisible();

    // Back under All namespaces the list is refused and points at the selector, which now offers
    // the namespace used before, since the cluster still will not list any.
    await window.getByTestId('namespace-selector').click();
    await window.getByRole('option', { name: 'All namespaces' }).click();
    await expect(window.getByTestId('forbidden-namespace-hint')).toBeVisible();
    await window.getByTestId('namespace-selector').click();
    await window.getByRole('option', { name: NAMESPACE, exact: true }).click();
    await expect(window.getByTestId('pods-table').locator('[data-pod^="web-"]').first()).toBeVisible();
});
