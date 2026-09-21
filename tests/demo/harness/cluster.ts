import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { K3sContainer, type StartedK3sContainer } from '@testcontainers/k3s';

/**
 * The demo cluster the screenshots are taken against: a second disposable k3s container, kept apart
 * from the end-to-end one by its own name, kubeconfig and state file so a screenshot run and a test
 * run can never reach into each other's cluster.
 *
 * It differs from the end-to-end cluster in what it leaves switched on. That harness disables
 * metrics-server, traefik and servicelb because the specs do not need them; here they are the
 * picture. Without metrics-server the dashboard charts, the usage meters on every list and the
 * per-container figures are all zeroes, and without traefik there is no IngressClass and no Ingress
 * row.
 */

export const K3S_IMAGE = 'rancher/k3s:v1.36.4-k3s1';
/** Reads as a cluster somebody runs, since the top bar and the dashboard both name it. */
export const CONTEXT_NAME = 'orbit-production';
export const NAMESPACE = 'production';
export const KUBECONFIG_PATH = resolve('tests/demo/.kubeconfig');
export const CONTAINER_NAME = 'km-demo-cluster';
export const CLUSTER_STATE_PATH = resolve('tests/demo/.cluster.json');

/**
 * The demo cluster is kept between runs by default, which the end-to-end one is not. Screenshots
 * are taken over and over while a shot is composed, and every object's Age column reads "30s" on a
 * cluster that booted a minute ago: letting one soak makes the ages look like a cluster that has
 * been up a while. `KM_DEMO_FRESH=1` starts over.
 */
export const FRESH = process.env.KM_DEMO_FRESH === '1';

const SEED_PATH = resolve('tests/demo/fixtures/seed.yaml');
const CUSTOM_SEED_PATH = resolve('tests/demo/fixtures/seed-custom.yaml');
const CHART_PATH = resolve('tests/demo/fixtures/chart');
const RELEASE_NAME = 'platform-agent';
const RELEASE_NAMESPACE = 'platform';

let started: StartedK3sContainer | undefined;

function kubectl(containerId: string, args: string[], input?: string): string {
    return execFileSync('docker', ['exec', '-i', containerId, 'kubectl', ...args], { encoding: 'utf8', input });
}

/** Whether a container of that name is already up, so a kept cluster is reused rather than reseeded. */
function runningContainerId(): string | undefined {
    const id = execFileSync('docker', ['ps', '--quiet', '--filter', `name=^/${CONTAINER_NAME}$`], {
        encoding: 'utf8',
    }).trim();
    return id === '' ? undefined : id;
}

export async function ensureCluster(): Promise<void> {
    if (FRESH) {
        try {
            execFileSync('docker', ['rm', '--force', CONTAINER_NAME], { stdio: 'ignore' });
        } catch {
            // Nothing to remove is the normal case on a first run.
        }
    } else {
        const existing = runningContainerId();
        if (existing && existsSync(KUBECONFIG_PATH)) {
            console.log(`[demo] reusing ${CONTAINER_NAME}; KM_DEMO_FRESH=1 to start over`);
            writeFileSync(CLUSTER_STATE_PATH, JSON.stringify({ containerId: existing }));
            return;
        }
    }

    // Every add-on left on: metrics-server is what fills the charts and the usage meters, traefik
    // is what gives the cluster an IngressClass and an Ingress with an address, and servicelb is
    // what keeps traefik's own Service from sitting Pending in the screenshot of the Services list.
    // The command has to be given in full: `K3sContainer` disables traefik in its own default.
    const container = new K3sContainer(K3S_IMAGE).withCommand(['server']).withName(CONTAINER_NAME).withReuse();
    started = await container.start();
    const containerId = started.getId();
    writeFileSync(KUBECONFIG_PATH, started.getKubeConfig().replace(/\bdefault\b/g, CONTEXT_NAME));
    writeFileSync(CLUSTER_STATE_PATH, JSON.stringify({ containerId }));

    kubectl(containerId, ['apply', '-f', '-'], readFileSync(SEED_PATH, 'utf8'));
    // A custom resource cannot be created until the API server serves its kind.
    kubectl(containerId, ['wait', '--for=condition=Established', '--timeout=60s', 'crd/queues.messaging.example.com']);
    kubectl(containerId, ['apply', '-f', '-'], readFileSync(CUSTOM_SEED_PATH, 'utf8'));

    installRelease();

    // The healthy workloads have to be up before anything is photographed. Only those: the three
    // broken ones never will be, which is the point of them, and `--all` would wait for them too.
    const healthy: [string, string][] = [
        ['production', 'checkout'],
        ['production', 'payments-api'],
        ['production', 'ingest-worker'],
        ['staging', 'checkout'],
        ['staging', 'payments-api'],
        ['platform', 'search-indexer'],
    ];
    for (const [namespace, name] of healthy) {
        try {
            kubectl(containerId, [
                '-n',
                namespace,
                'wait',
                '--for=condition=Available',
                '--timeout=240s',
                `deployment/${name}`,
            ]);
        } catch {
            console.warn(`[demo] ${namespace}/${name} did not become available in time; shooting anyway`);
        }
    }
    // Metrics take a further minute or so to start reporting; the sampler needs them for the charts.
    await waitForMetrics(containerId);
    console.log(`[demo] cluster ready, kubeconfig at ${KUBECONFIG_PATH}`);
}

/**
 * A real `helm install` followed by a real `helm upgrade`, rather than the encoded release Secrets
 * the end-to-end seed carries. Two revisions of an actual release mean the revision history, the
 * values diff and the rollback all read from bookkeeping Helm itself wrote.
 */
function installRelease(): void {
    try {
        execFileSync('helm', ['version', '--short'], { encoding: 'utf8' });
    } catch {
        console.warn('[demo] helm not on PATH: the Helm screens will have no release to show');
        return;
    }
    const base = ['--kubeconfig', KUBECONFIG_PATH, '--namespace', RELEASE_NAMESPACE];
    execFileSync('helm', ['install', RELEASE_NAME, CHART_PATH, ...base, '--wait', '--timeout', '3m'], {
        encoding: 'utf8',
    });
    execFileSync(
        'helm',
        [
            'upgrade',
            RELEASE_NAME,
            CHART_PATH,
            ...base,
            '--set',
            'tracing.enabled=true',
            '--set',
            'logLevel=debug',
            '--wait',
            '--timeout',
            '3m',
        ],
        { encoding: 'utf8' },
    );
}

/** metrics-server answers `top` only once it has scraped; until then every usage figure is zero. */
async function waitForMetrics(containerId: string): Promise<void> {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
        try {
            kubectl(containerId, ['top', 'nodes', '--no-headers']);
            return;
        } catch {
            await new Promise((done) => setTimeout(done, 5_000));
        }
    }
    console.warn('[demo] metrics-server never reported: charts and usage meters will be empty');
}

export async function stopCluster(): Promise<void> {
    if (!FRESH) {
        console.log(`[demo] keeping ${CONTAINER_NAME}; remove with docker rm -f ${CONTAINER_NAME}`);
        return;
    }
    await started?.stop();
}

/** Run kubectl inside the demo cluster from a shot, e.g. to resolve a pod's generated name. */
export function clusterKubectl(args: string[]): string {
    const { containerId } = JSON.parse(readFileSync(CLUSTER_STATE_PATH, 'utf8')) as { containerId: string };
    return execFileSync('docker', ['exec', containerId, 'kubectl', ...args], { encoding: 'utf8' });
}
