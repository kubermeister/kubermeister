import { describe, expect, it } from 'vitest';
import { completionsAt, describeAt } from '@/lib/manifest-completion';
import { valuesLens } from '@/lib/values-schema';
import { webChart } from './values-schema-fixture';

const lens = valuesLens(webChart);

/** Complete where `|` stands in the text, which is where the cursor is. */
function at(marked: string) {
    const offset = marked.indexOf('|');
    const text = marked.slice(0, offset) + marked.slice(offset + 1);
    const found = completionsAt(text, offset, lens);
    return found && { labels: found.options.map((option) => option.label), found };
}

describe('completing chart values from the chart’s schema', () => {
    it('offers the top-level values, required first, leaving out the ones written', () => {
        const result = at('replicaCount: 2\n|');
        expect(result?.labels).toEqual([
            'image',
            'service',
            'ingress',
            'resources',
            'env',
            'labels',
            'pair',
            'mode',
            'extra',
            'forbidden',
            'remote',
        ]);
        expect(result?.found.options.find((option) => option.label === 'image')).toMatchObject({
            apply: 'image:',
            boost: 1,
            detail: 'required · an object',
        });
    });

    it('follows a $ref, both halves of an allOf and a list’s items through $defs', () => {
        expect(at('image:\n  |')?.labels).toEqual(['repository', 'tag', 'pullPolicy']);
        expect(at('ingress:\n  |')?.labels).toEqual(['enabled', 'hosts']);
        expect(at('ingress:\n  hosts:\n    - |')?.labels).toEqual(['host', 'paths']);
    });

    it('offers what any form of a oneOf holds, since the value has not yet chosen one', () => {
        expect(at('resources:\n  |')?.labels).toEqual(['cpu', 'memory']);
        expect(at('resources: |')?.labels).toEqual(['small', 'large']);
    });

    it('completes an enum, a const and true or false as values', () => {
        expect(at('image:\n  pullPolicy: |')?.labels).toEqual(['Always', 'IfNotPresent', 'Never']);
        expect(at('mode: |')?.labels).toEqual(['standard']);
        expect(at('ingress:\n  enabled: |')?.labels).toEqual(['true', 'false']);
    });

    it('offers nothing where the schema has nothing to say', () => {
        expect(at('extra:\n  |')).toBe(null);
        expect(at('remote:\n  |')).toBe(null);
        expect(at('unknown:\n  |')).toBe(null);
    });

    it('describes a value from its description, or its title when it has none', () => {
        const text = 'replicaCount: 2\nservice:\n  type: ClusterIP\nimage:\n  repository: nginx\n';
        expect(describeAt(text, 2, lens)).toMatchObject({
            title: 'replicaCount',
            detail: 'a whole number',
            description: 'How many pods to run.',
        });
        expect(describeAt(text, text.indexOf('type') + 1, lens)).toMatchObject({ description: 'Service type' });
        expect(describeAt(text, text.indexOf('repository') + 1, lens)).toMatchObject({
            detail: 'a string · required',
            description: 'Where the image is pulled from.',
        });
    });
});
