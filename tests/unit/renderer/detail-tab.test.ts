import { describe, expect, it } from 'vitest';
import { isTabSwitch } from '@/lib/detail-tab';

const route = '/workloads/deployments/$namespace/$name/{-$tab}';
const at = (params: Record<string, string | undefined>, routeId = route) => ({ routeId, params });

describe('isTabSwitch', () => {
    it('holds for another tab of the same object, the bare first tab included', () => {
        const manifest = at({ namespace: 'prod', name: 'web', tab: 'manifest' });
        expect(isTabSwitch(manifest, at({ namespace: 'prod', name: 'web', tab: 'events' }))).toBe(true);
        expect(isTabSwitch(manifest, at({ namespace: 'prod', name: 'web' }))).toBe(true);
    });

    it('fails for another object of the same kind', () => {
        const manifest = at({ namespace: 'prod', name: 'web', tab: 'manifest' });
        expect(isTabSwitch(manifest, at({ namespace: 'prod', name: 'api', tab: 'manifest' }))).toBe(false);
        expect(isTabSwitch(manifest, at({ namespace: 'staging', name: 'web', tab: 'manifest' }))).toBe(false);
    });

    it('fails for another route, even one with the same params', () => {
        const manifest = at({ namespace: 'prod', name: 'web', tab: 'manifest' });
        expect(isTabSwitch(manifest, at({}, '/workloads/deployments/'))).toBe(false);
        expect(
            isTabSwitch(manifest, at({ namespace: 'prod', name: 'web' }, '/workloads/pods/$namespace/$name/{-$tab}')),
        ).toBe(false);
    });
});
