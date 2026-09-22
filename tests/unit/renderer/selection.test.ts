import { describe, expect, it } from 'vitest';
import { bulkDeleteSummary, selectionRowId, failedSelection, mapWithConcurrency } from '@/lib/selection';

describe('selectionRowId', () => {
    it('qualifies a row by its namespace so same-named objects stay distinct', () => {
        expect(selectionRowId({ name: 'web', namespace: 'team-a' })).toBe('team-a/web');
        expect(selectionRowId({ name: 'web', namespace: 'team-b' })).not.toBe(
            selectionRowId({ name: 'web', namespace: 'team-a' }),
        );
    });

    it('gives a cluster-scoped row an id with no namespace part', () => {
        expect(selectionRowId({ name: 'pv-1' })).toBe('/pv-1');
    });
});

describe('mapWithConcurrency', () => {
    it('keeps the results in the order of the input', async () => {
        const out = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
            await new Promise((resolve) => setTimeout(resolve, n));
            return n * 10;
        });
        expect(out).toEqual([30, 10, 20]);
    });

    it('never runs more than the limit at once', async () => {
        let running = 0;
        let peak = 0;
        await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
            running += 1;
            peak = Math.max(peak, running);
            await new Promise((resolve) => setTimeout(resolve, 1));
            running -= 1;
        });
        expect(peak).toBe(2);
    });

    it('handles an empty input and a limit larger than the batch', async () => {
        expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
        expect(await mapWithConcurrency([1], 10, async (n) => n)).toEqual([1]);
    });
});

describe('bulkDeleteSummary', () => {
    it('uses the singular for one object and the plural for several', () => {
        expect(bulkDeleteSummary({ deleted: [{ name: 'a' }], failed: [] }, 'Pod', 'Pods')).toEqual({
            ok: true,
            message: '1 Pod deleted',
        });
        expect(bulkDeleteSummary({ deleted: [{ name: 'a' }, { name: 'b' }], failed: [] }, 'Pod', 'Pods').message).toBe(
            '2 Pods deleted',
        );
    });

    it('names every failure and its reason when some could not be deleted', () => {
        const summary = bulkDeleteSummary(
            {
                deleted: [{ name: 'a', namespace: 'team-a' }],
                failed: [
                    { name: 'b', namespace: 'team-a', message: 'forbidden' },
                    { name: 'pv-1', message: 'in use' },
                ],
            },
            'Pod',
            'Pods',
        );
        expect(summary.ok).toBe(false);
        expect(summary.message).toBe('1 Pod deleted, 2 failed');
        expect(summary.detail).toBe('team-a/b: forbidden; pv-1: in use');
    });
});

describe('failedSelection', () => {
    it('keeps exactly the failed rows checked, so a retry starts from them', () => {
        expect(failedSelection([{ name: 'b', namespace: 'team-a' }, { name: 'pv-1' }])).toEqual({
            'team-a/b': true,
            '/pv-1': true,
        });
        expect(failedSelection([])).toEqual({});
    });
});
