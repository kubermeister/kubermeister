import { KubeConfig, type KubernetesListObject, type KubernetesObject } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import { makeInformer, ReportingWatch } from '../../../src/main/k8s/informer.js';

/** A kubeconfig whose credential plugin cannot renew the token, as an expired SSO session does. */
function failingAuthConfig(): KubeConfig {
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromOptions({
        clusters: [{ name: 'c', server: 'https://127.0.0.1:6443' }],
        users: [{ name: 'u' }],
        contexts: [{ name: 'x', cluster: 'c', user: 'u' }],
        currentContext: 'x',
    });
    vi.spyOn(kubeConfig, 'applySecurityAuthentication').mockRejectedValue(new Error('exec plugin aws failed'));
    return kubeConfig;
}

const emptyList = async (): Promise<KubernetesListObject<KubernetesObject>> => ({
    items: [],
    metadata: { resourceVersion: '7' },
});

describe('ReportingWatch', () => {
    it('hands a failed authentication to done instead of rejecting', async () => {
        const done = vi.fn();
        const request = await new ReportingWatch(failingAuthConfig()).watch('/api/v1/pods', {}, vi.fn(), done);
        expect(done).toHaveBeenCalledWith(expect.objectContaining({ message: 'exec plugin aws failed' }));
        expect(request).toBeInstanceOf(AbortController);
    });

    it('still fails done for a kubeconfig with no cluster', async () => {
        const done = vi.fn();
        await new ReportingWatch(new KubeConfig()).watch('/api/v1/pods', {}, vi.fn(), done);
        expect(done).toHaveBeenCalledWith(expect.objectContaining({ message: 'No currently active cluster' }));
    });
});

describe('makeInformer', () => {
    it('reports a watch that cannot authenticate as an informer error, and resolves its start', async () => {
        const informer = makeInformer(failingAuthConfig(), '/api/v1/pods', emptyList);
        const onError = vi.fn();
        informer.on('error', onError);
        await expect(informer.start()).resolves.toBeUndefined();
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'exec plugin aws failed' }));
        await informer.stop();
    });

    it('does not start on its own', async () => {
        const list = vi.fn(emptyList);
        makeInformer(failingAuthConfig(), '/api/v1/pods', list);
        await Promise.resolve();
        expect(list).not.toHaveBeenCalled();
    });
});
