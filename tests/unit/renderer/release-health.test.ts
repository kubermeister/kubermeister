import { describe, expect, it } from 'vitest';
import type { ReleaseObject } from '../../../src/shared/k8s/addons';
import { objectBadge, rollUp } from '../../../src/renderer/lib/release-health';

const present = (kind: string, name: string, status: ReleaseObject['status'] = null): ReleaseObject => ({
    apiVersion: 'v1',
    kind,
    name,
    namespace: 'team-a',
    state: 'Present',
    status,
    path: null,
});
const missing = (kind: string, name: string): ReleaseObject => ({ ...present(kind, name), state: 'Missing' });
const unknown = (kind: string, name: string): ReleaseObject => ({
    ...present(kind, name),
    state: 'Unknown',
    note: `Not allowed to list ${kind} objects.`,
});

describe('an object’s badge', () => {
    it("uses its kind's own status word and tone map", () => {
        expect(objectBadge(present('Pod', 'web-1', { kind: 'Pod', value: 'CrashLoop' }))).toEqual({
            label: 'CrashLoop',
            tone: 'danger',
        });
        expect(objectBadge(present('Deployment', 'web', { kind: 'Deployment', value: 'Healthy' }))).toEqual({
            label: 'Healthy',
            tone: 'ok',
        });
        expect(objectBadge(present('Service', 'web', { kind: 'Service', value: 'Pending' }))).toEqual({
            label: 'Pending',
            tone: 'warn',
        });
    });

    it('reads plain present or missing for a kind with no status, and neutral for a word no map knows', () => {
        expect(objectBadge(present('ConfigMap', 'web'))).toEqual({ label: 'Present', tone: 'ok' });
        expect(objectBadge(missing('ConfigMap', 'web'))).toEqual({ label: 'Missing', tone: 'danger' });
        expect(objectBadge(unknown('ClusterRole', 'web'))).toEqual({ label: 'Unknown', tone: 'neutral' });
        expect(objectBadge(present('Pod', 'web', { kind: 'Pod', value: 'Sleeping' }))).toEqual({
            label: 'Sleeping',
            tone: 'neutral',
        });
    });
});

describe('a release’s roll-up', () => {
    it('is healthy when every object is present and none is in trouble', () => {
        const rollup = rollUp([
            present('Deployment', 'web', { kind: 'Deployment', value: 'Healthy' }),
            present('ConfigMap', 'web'),
            present('Job', 'migrate', { kind: 'Job', value: 'Running' }),
        ]);
        expect(rollup).toEqual({ health: 'Healthy', reason: 'All 3 objects are present and healthy.' });
        expect(rollUp([present('ConfigMap', 'web')]).reason).toBe('Its one object is present and healthy.');
    });

    it('names the worst object as the reason, the first of them in manifest order', () => {
        const progressing = present('Deployment', 'web', { kind: 'Deployment', value: 'Progressing' });
        const gone = missing('ConfigMap', 'web-config');
        const alsoGone = missing('Secret', 'web-tls');
        const rollup = rollUp([progressing, gone, alsoGone]);
        expect(rollup.health).toBe('Failing');
        expect(rollup.worst).toBe(gone);
        expect(rollup.reason).toBe('ConfigMap web-config is Missing, and 2 other objects need attention.');
    });

    it('is degraded when the worst object is only a warning', () => {
        const rollup = rollUp([
            present('ConfigMap', 'web'),
            present('Deployment', 'web', { kind: 'Deployment', value: 'Progressing' }),
        ]);
        expect(rollup).toMatchObject({ health: 'Degraded', reason: 'Deployment web is Progressing.' });
    });

    it('never claims health it could not check', () => {
        const rollup = rollUp([present('ConfigMap', 'web'), unknown('ClusterRole', 'web-reader')]);
        expect(rollup).toMatchObject({
            health: 'Unknown',
            reason: '1 object could not be read: Not allowed to list ClusterRole objects.',
        });
    });

    it('lets a real problem outrank an object it could not read', () => {
        expect(rollUp([unknown('ClusterRole', 'web-reader'), missing('ConfigMap', 'web')]).health).toBe('Failing');
    });

    it('has nothing to judge when the revision rendered no objects', () => {
        expect(rollUp([]).health).toBe('Unknown');
    });
});
