import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { K3sContainer, type StartedK3sContainer } from '@testcontainers/k3s';

/**
 * The isolated end-to-end cluster: one k3s container managed by Testcontainers, which picks a
 * free host port, waits for readiness, and runs its reaper so the container disappears even if
 * the test process crashes. Nothing is installed on the host: kubectl runs inside the container
 * through `docker exec`, and the kubeconfig is written to a gitignored file, so the developer's
 * own kubeconfig is never read or written.
 */

export const K3S_IMAGE = 'rancher/k3s:v1.36.4-k3s1';
export const CONTEXT_NAME = 'km-e2e-ctx';
export const NAMESPACE = 'km-e2e';
export const KUBECONFIG_PATH = resolve('tests/e2e/.kubeconfig');
export const CONTAINER_NAME = 'km-e2e-cluster';
/** Where global setup records the container id for the spec workers, which run in other processes. */
export const CLUSTER_STATE_PATH = resolve('tests/e2e/.cluster.json');
/** Keep the container between runs (skips the cluster boot); remove with `docker rm -f km-e2e-cluster`. */
export const KEEP_CLUSTER = process.env.KM_E2E_KEEP_CLUSTER === '1';

const FIXTURES_PATH = resolve('tests/e2e/fixtures/seed.yaml');
const CUSTOM_FIXTURES_PATH = resolve('tests/e2e/fixtures/seed-custom.yaml');

let started: StartedK3sContainer | undefined;

function kubectl(containerId: string, args: string[], input?: string): void {
    execFileSync('docker', ['exec', '-i', containerId, 'kubectl', ...args], { encoding: 'utf8', input });
}

export async function ensureCluster(): Promise<void> {
    const container = new K3sContainer(K3S_IMAGE).withCommand([
        'server',
        '--disable=traefik',
        '--disable=servicelb',
        '--disable=metrics-server',
    ]);
    // Spike for #198: a nested VM boots k3s slower than the library's two minutes allow.
    if (process.env.KM_E2E_STARTUP_TIMEOUT_MS)
        container.withStartupTimeout(Number(process.env.KM_E2E_STARTUP_TIMEOUT_MS));
    if (KEEP_CLUSTER) container.withName(CONTAINER_NAME).withReuse();
    started = await container.start();
    // Rename the generic "default" context, cluster and user so the UI shows an unmistakable name.
    writeFileSync(KUBECONFIG_PATH, started.getKubeConfig().replace(/\bdefault\b/g, CONTEXT_NAME));
    kubectl(started.getId(), ['apply', '-f', '-'], readFileSync(FIXTURES_PATH, 'utf8'));
    // A custom resource cannot be created until the API server serves its kind, so the instances
    // of the seeded definition come in a second pass once that definition is established.
    kubectl(started.getId(), ['wait', '--for=condition=Established', '--timeout=60s', 'crd/widgets.km-e2e.test']);
    kubectl(started.getId(), ['apply', '-f', '-'], readFileSync(CUSTOM_FIXTURES_PATH, 'utf8'));
    // The specs assert on running pods, so wait for the seeded workload before any app launches.
    kubectl(started.getId(), [
        '-n',
        NAMESPACE,
        'wait',
        '--for=condition=Available',
        '--timeout=180s',
        'deployment',
        '--all',
    ]);
    writeFileSync(CLUSTER_STATE_PATH, JSON.stringify({ containerId: started.getId() }));
    console.log(`[e2e] cluster ready, kubeconfig at ${KUBECONFIG_PATH}`);
}

export async function stopCluster(): Promise<void> {
    if (KEEP_CLUSTER) {
        console.log(
            `[e2e] KM_E2E_KEEP_CLUSTER=1: keeping ${CONTAINER_NAME}; remove with docker rm -f ${CONTAINER_NAME}`,
        );
        return;
    }
    await started?.stop();
}

/** Run kubectl inside the test cluster's container from a spec, e.g. to mutate seeded objects. */
export function clusterKubectl(args: string[]): string {
    const { containerId } = JSON.parse(readFileSync(CLUSTER_STATE_PATH, 'utf8')) as { containerId: string };
    return execFileSync('docker', ['exec', containerId, 'kubectl', ...args], { encoding: 'utf8' });
}
