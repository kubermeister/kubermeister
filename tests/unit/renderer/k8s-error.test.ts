import { describe, expect, it } from 'vitest';
import { IpcError } from '../../../src/renderer/lib/ipc';
import { describeError } from '../../../src/renderer/lib/k8s-error';

describe('describeError', () => {
    it('titles every classified kind and keeps the structured detail', () => {
        const cases: Array<[Parameters<typeof IpcError.prototype.constructor>[0]['kind'], string]> = [
            ['kubeconfig', 'Kubeconfig not loaded'],
            ['forbidden', 'Access denied'],
            ['unreachable', 'Cluster unreachable'],
            ['timeout', 'Cluster timed out'],
            ['unauthorized', 'Not authenticated'],
            ['notFound', 'Not found'],
            ['conflict', 'Conflict'],
            ['invalid', 'Invalid manifest'],
            ['unknown', 'Something went wrong'],
        ];
        for (const [kind, title] of cases) {
            expect(describeError(new IpcError({ kind, detail: 'why', op: 'x' }))).toEqual({
                kind,
                title,
                detail: 'why',
            });
        }
    });

    it('falls back to the title when a classified error has no detail', () => {
        expect(describeError(new IpcError({ kind: 'forbidden', detail: '', op: 'x' })).detail).toBe('Access denied');
    });

    it('treats plain errors, strings and anything else as unknown', () => {
        expect(describeError(new Error('boom'))).toEqual({
            kind: 'unknown',
            title: 'Something went wrong',
            detail: 'boom',
        });
        expect(describeError('plain')).toMatchObject({ kind: 'unknown', detail: 'plain' });
        expect(describeError(undefined).detail).toBe('Something went wrong');
        expect(describeError({ weird: true }).detail).toBe('Something went wrong');
    });
});
