import { describe, expect, it } from 'vitest';
import { containerChoices } from '@/lib/pod-containers';

const container = (name: string, role: 'app' | 'init' | 'ephemeral') => ({ name, role });

describe('containerChoices', () => {
    const pod = [
        container('migrate', 'init'),
        container('web', 'app'),
        container('sidecar', 'app'),
        container('debugger', 'ephemeral'),
    ];

    it('puts the app containers first, so the default a tab opens on is one that runs the app', () => {
        expect(containerChoices(pod, ['app', 'init', 'ephemeral']).map((c) => c.name)).toEqual([
            'web',
            'sidecar',
            'migrate',
            'debugger',
        ]);
    });

    it('offers only the roles asked for', () => {
        expect(containerChoices(pod, ['app', 'ephemeral']).map((c) => c.name)).toEqual(['web', 'sidecar', 'debugger']);
    });

    it('has nothing to offer before the pod has loaded', () => {
        expect(containerChoices(undefined, ['app'])).toEqual([]);
    });
});
