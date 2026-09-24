import { describe, expect, it } from 'vitest';
import { completionsAt, describeAt } from '@/lib/manifest-completion';
import { deployment } from './schema-fixture';

/** Complete where `|` stands in the text, which is where the cursor is. */
function at(marked: string) {
    const offset = marked.indexOf('|');
    const text = marked.slice(0, offset) + marked.slice(offset + 1);
    const found = completionsAt(text, offset, deployment);
    return (
        found && { word: text.slice(found.from, offset), labels: found.options.map((option) => option.label), found }
    );
}

const HEAD = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n';

describe('completing a manifest', () => {
    it('offers the fields of the mapping the cursor is in, leaving out the ones already written', () => {
        const result = at(`${HEAD}spec:\n  replicas: 2\n  sel|\n  template: {}\n`);
        expect(result?.word).toBe('sel');
        // Every field the mapping lacks; CodeMirror narrows them to the typed word itself.
        expect(result?.labels).toEqual(['selector', 'strategy', 'extra']);
    });

    it('puts required fields first and says what each holds', () => {
        const result = at(`${HEAD}spec:\n  |`);
        const selector = result?.found.options.find((option) => option.label === 'selector');
        expect(selector).toMatchObject({ apply: 'selector:', boost: 1, detail: 'required · an object' });
        const replicas = result?.found.options.find((option) => option.label === 'replicas');
        expect(replicas).toMatchObject({
            apply: 'replicas: ',
            boost: 0,
            detail: 'a whole number',
            info: 'Number of desired pods.',
        });
    });

    it('follows a list item into the schema of its items, in either indentation style', () => {
        const indented = at(
            `${HEAD}spec:\n  template:\n    spec:\n      containers:\n        - name: web\n          ima|\n`,
        );
        // Narrowing to the typed word is CodeMirror's; this offers the item's fields but the one it has.
        expect(indented?.word).toBe('ima');
        expect(indented?.labels).toEqual([
            'image',
            'imagePullPolicy',
            'stdin',
            'env',
            'ports',
            'resources',
            'readinessProbe',
        ]);
        const flush = at(`${HEAD}spec:\n  template:\n    spec:\n      containers:\n      - name: web\n        std|\n`);
        expect(flush?.labels).toContain('stdin');
    });

    it('offers every field of a new list item, and none for a list of anything else', () => {
        const fresh = at(`${HEAD}spec:\n  template:\n    spec:\n      containers:\n        - name: a\n        - |\n`);
        expect(fresh?.labels).toContain('name');
        expect(fresh?.labels).toContain('image');
    });

    it('offers the values an enum allows, and true and false for a switch', () => {
        const pull = at(
            `${HEAD}spec:\n  template:\n    spec:\n      containers:\n        - name: a\n          imagePullPolicy: If|\n`,
        );
        expect(pull?.word).toBe('If');
        expect(pull?.labels).toEqual(['Always', 'IfNotPresent', 'Never']);
        const flag = at(`${HEAD}spec:\n  template:\n    spec:\n      containers:\n        - stdin: |\n`);
        expect(flag?.labels).toEqual(['true', 'false']);
        expect(at(`${HEAD}spec:\n  replicas: |\n`)).toBe(null);
    });

    it('offers nothing where the schema has nothing to say or the YAML is not block style', () => {
        // Anything goes under a field that keeps unknown fields.
        expect(at(`${HEAD}spec:\n  extra:\n    |\n`)).toBe(null);
        expect(at(`${HEAD}spec:\n  nowhere:\n    |\n`)).toBe(null);
        expect(at(`${HEAD}spec:\n  replicas: 2\n    |\n`)).toBe(null);
        // Retyping a key that already has its colon is no moment to insert another.
        expect(at(`${HEAD}spec:\n  repl|icas: 2\n`)).toBe(null);
    });

    it('offers the top-level fields at the start of the document', () => {
        expect(at('apiVersion: apps/v1\nkind: Deployment\n|')?.labels).toEqual(['metadata', 'spec']);
    });
});

describe('describing a field', () => {
    it('names the field under the cursor, what it holds and what it is for', () => {
        const text = `${HEAD}spec:\n  replicas: 2\n`;
        const offset = text.indexOf('replicas') + 3;
        expect(describeAt(text, offset, deployment)).toEqual({
            from: text.indexOf('replicas'),
            to: text.indexOf('replicas') + 'replicas'.length,
            title: 'replicas',
            detail: 'a whole number',
            description: 'Number of desired pods.',
        });
    });

    it('says a field is required, inside a list item too', () => {
        const text = `${HEAD}spec:\n  template:\n    spec:\n      containers:\n        - name: web\n`;
        const described = describeAt(text, text.lastIndexOf('name') + 1, deployment);
        expect(described).toMatchObject({
            title: 'name',
            detail: 'a string · required',
            description: 'Name of the container.',
        });
    });

    it('describes nothing off a key or where the schema has no such field', () => {
        const text = `${HEAD}spec:\n  replicas: 2\n  colour: red\n`;
        expect(describeAt(text, text.indexOf(': 2') + 2, deployment)).toBe(null);
        expect(describeAt(text, text.indexOf('colour') + 1, deployment)).toBe(null);
    });
});
