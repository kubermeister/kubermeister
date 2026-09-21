import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/shared/settings';

const client = {
    kubeconfigError: vi.fn<() => string | null>(),
    currentContextProblem: vi.fn<() => string | null>(() => null),
    apis: vi.fn(),
    currentCluster: vi.fn<() => { name: string; server: string; skipTLSVerify: boolean } | null>(() => null),
};
const context = { getCurrentContext: vi.fn() };
const proxy = {
    caBundleProblem: vi.fn<() => string | null>(() => null),
    networkSummary: vi.fn(() => 'Connecting directly'),
};
const store = { getSettings: vi.fn(() => DEFAULT_SETTINGS) };
vi.mock('../../../src/main/k8s/client.js', () => client);
vi.mock('../../../src/main/k8s/context.js', () => context);
vi.mock('../../../src/main/k8s/proxy.js', () => proxy);
vi.mock('../../../src/main/settings/store.js', () => store);

const { checkKubeconfig, checkContext, checkCluster, checkNetwork, runStartupChecks } =
    await import('../../../src/main/startup/checks.js');

function version(getCode: () => Promise<unknown>): void {
    client.apis.mockReturnValue({ version: { getCode } });
}

// The network check runs in every report, so its stubs start healthy for the checks that are not about it.
beforeEach(() => {
    proxy.caBundleProblem.mockReturnValue(null);
    proxy.networkSummary.mockReturnValue('Connecting directly');
    client.currentCluster.mockReturnValue(null);
});

describe('checkKubeconfig', () => {
    it('is ok when the kubeconfig loads', () => {
        client.kubeconfigError.mockReturnValue(null);
        expect(checkKubeconfig()).toEqual({
            id: 'kubeconfig',
            label: 'Kubeconfig file',
            status: 'ok',
            detail: 'Kubeconfig loaded',
        });
    });

    it('is an error with a settings hint for a broken override', () => {
        client.kubeconfigError.mockReturnValue('No file exists at /k.');
        expect(checkKubeconfig()).toMatchObject({
            status: 'error',
            detail: 'No file exists at /k.',
            hint: expect.stringContaining('Settings'),
        });
    });

    it('is an error with an on-disk hint for a broken default', () => {
        client.kubeconfigError.mockReturnValue(
            'The default kubeconfig ($KUBECONFIG or ~/.kube/config) could not be parsed.',
        );
        expect(checkKubeconfig()).toMatchObject({ status: 'error', hint: expect.stringContaining('~/.kube/config') });
    });
});

describe('checkContext', () => {
    beforeEach(() => {
        client.currentContextProblem.mockReturnValue(null);
        context.getCurrentContext.mockReturnValue({ name: 'alpha', cluster: 'c', user: 'u', current: true });
    });

    it('is ok naming the context it will use', () => {
        expect(checkContext()).toEqual({
            id: 'context',
            label: 'Current context',
            status: 'ok',
            detail: 'Using alpha',
        });
    });

    it('is an error, with a hint to switch, when the context names a missing cluster or user', () => {
        client.currentContextProblem.mockReturnValue('Context "alpha" names cluster "nowhere", which ...');
        expect(checkContext()).toMatchObject({
            status: 'error',
            detail: expect.stringContaining('nowhere'),
            hint: expect.stringContaining('Switch to another context'),
        });
    });

    it('only warns when no context is current at all', () => {
        context.getCurrentContext.mockReturnValue(null);
        expect(checkContext()).toMatchObject({
            status: 'warning',
            detail: expect.stringContaining('No current context'),
        });
    });

    it('turns a throw while reading the config into the error, without the kind prefix', () => {
        context.getCurrentContext.mockImplementation(() => {
            throw new Error('[kubeconfig] /k could not be parsed as a kubeconfig file.');
        });
        expect(checkContext()).toMatchObject({
            status: 'error',
            detail: '/k could not be parsed as a kubeconfig file.',
        });
    });
});

describe('checkCluster', () => {
    beforeEach(() => {
        context.getCurrentContext.mockReturnValue({ name: 'alpha', cluster: 'c', user: 'u', current: true });
    });

    it('reports the server version when the probe succeeds', async () => {
        version(() => Promise.resolve({ gitVersion: 'v1.34.0' }));
        expect(await checkCluster()).toMatchObject({ status: 'ok', detail: 'Connected to alpha (Kubernetes v1.34.0)' });
    });

    it('warns without a current context', async () => {
        context.getCurrentContext.mockReturnValue(null);
        expect(await checkCluster()).toMatchObject({
            status: 'warning',
            detail: expect.stringContaining('No current context'),
        });
    });

    it('warns, never errors, when the cluster is unreachable, and strips the kind prefix', async () => {
        version(() => Promise.reject(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })));
        const check = await checkCluster();
        expect(check.status).toBe('warning');
        expect(check.detail).toBe('The cluster API server is unreachable.');
    });

    it('warns when loading the config itself throws', async () => {
        context.getCurrentContext.mockImplementation(() => {
            throw new Error('bad yaml');
        });
        expect(await checkCluster()).toMatchObject({ status: 'warning', detail: 'bad yaml' });
    });
});

describe('checkNetwork', () => {
    beforeEach(() => {
        proxy.caBundleProblem.mockReturnValue(null);
        proxy.networkSummary.mockReturnValue('Proxying through http://proxy:3128');
        client.currentCluster.mockReturnValue({ name: 'c', server: 'https://api', skipTLSVerify: false });
    });

    it('is ok, saying what the current cluster connects through', () => {
        expect(checkNetwork()).toEqual({
            id: 'network',
            label: 'Proxy and certificates',
            status: 'ok',
            detail: 'Proxying through http://proxy:3128',
        });
        expect(proxy.networkSummary).toHaveBeenCalledWith({ name: 'c', server: 'https://api', skipTLSVerify: false });
    });

    it('summarises without a cluster when the kubeconfig cannot give one', () => {
        client.currentCluster.mockImplementation(() => {
            throw new Error('[kubeconfig] /k could not be parsed as a kubeconfig file.');
        });
        expect(checkNetwork().status).toBe('ok');
        expect(proxy.networkSummary).toHaveBeenCalledWith(null);
    });

    it('is an error pointing at Settings when the CA bundle cannot be read', () => {
        proxy.caBundleProblem.mockReturnValue('No file exists at /etc/corp/ca.pem.');
        expect(checkNetwork()).toMatchObject({
            status: 'error',
            detail: 'No file exists at /etc/corp/ca.pem.',
            hint: expect.stringContaining('Settings'),
        });
    });
});

describe('runStartupChecks', () => {
    it('is ok when the kubeconfig loads even if the cluster is only a warning', async () => {
        client.kubeconfigError.mockReturnValue(null);
        context.getCurrentContext.mockReturnValue(null);
        const report = await runStartupChecks();
        expect(report.ok).toBe(true);
        expect(report.checks.map((c) => [c.id, c.status])).toEqual([
            ['kubeconfig', 'ok'],
            ['network', 'ok'],
            ['context', 'warning'],
            ['cluster', 'warning'],
        ]);
        expect(report.checks[3]?.detail).toContain('Skipped');
    });

    it('is not ok and skips the probe when the current context cannot be used', async () => {
        client.kubeconfigError.mockReturnValue(null);
        context.getCurrentContext.mockReturnValue({ name: 'alpha', cluster: 'nowhere', user: 'u', current: true });
        client.currentContextProblem.mockReturnValue('Context "alpha" names cluster "nowhere", which ...');
        client.apis.mockClear();
        const report = await runStartupChecks();
        expect(report.ok).toBe(false);
        expect(report.checks.map((c) => [c.id, c.status])).toEqual([
            ['kubeconfig', 'ok'],
            ['network', 'ok'],
            ['context', 'error'],
            ['cluster', 'warning'],
        ]);
        expect(client.apis).not.toHaveBeenCalled();
    });

    it('probes the cluster once the kubeconfig and its context are whole', async () => {
        client.kubeconfigError.mockReturnValue(null);
        context.getCurrentContext.mockReturnValue({ name: 'alpha', cluster: 'c', user: 'u', current: true });
        client.currentContextProblem.mockReturnValue(null);
        version(() => Promise.resolve({ gitVersion: 'v1.34.0' }));
        const report = await runStartupChecks();
        expect(report.ok).toBe(true);
        expect(report.checks.map((c) => c.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    });

    it('is not ok and skips the probe when the kubeconfig is broken', async () => {
        client.kubeconfigError.mockReturnValue('No file exists at /k.');
        client.apis.mockClear();
        const report = await runStartupChecks();
        expect(report.ok).toBe(false);
        expect(report.checks[2]).toMatchObject({
            id: 'context',
            status: 'warning',
            detail: expect.stringContaining('Skipped'),
        });
        expect(report.checks[3]).toMatchObject({
            id: 'cluster',
            status: 'warning',
            detail: expect.stringContaining('Skipped'),
        });
        expect(client.apis).not.toHaveBeenCalled();
    });

    it('is not ok when the CA bundle is unreadable, and still reports the rest', async () => {
        client.kubeconfigError.mockReturnValue(null);
        context.getCurrentContext.mockReturnValue({ name: 'alpha', cluster: 'c', user: 'u', current: true });
        client.currentContextProblem.mockReturnValue(null);
        proxy.caBundleProblem.mockReturnValue('No file exists at /etc/corp/ca.pem.');
        version(() => Promise.resolve({ gitVersion: 'v1.34.0' }));
        const report = await runStartupChecks();
        expect(report.ok).toBe(false);
        expect(report.checks.map((c) => [c.id, c.status])).toEqual([
            ['kubeconfig', 'ok'],
            ['network', 'error'],
            ['context', 'ok'],
            ['cluster', 'ok'],
        ]);
    });
});
