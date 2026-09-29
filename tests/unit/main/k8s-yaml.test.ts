import { describe, expect, it } from 'vitest';
import { loadAllRenderedYaml, loadRenderedYaml } from '../../../src/main/k8s/yaml.js';

const read = (scalar: string): unknown => (loadRenderedYaml(`v: ${scalar}`) as { v: unknown }).v;

describe('loadRenderedYaml', () => {
    it('reads a leading zero as octal, as sigs.k8s.io/yaml does', () => {
        expect(read('0755')).toBe(0o755);
        expect(read('0644')).toBe(0o644);
        expect(read('0400')).toBe(0o400);
        expect(read('-017')).toBe(-0o17);
        expect(read('0o17')).toBe(0o17);
    });

    it('reads the other integer forms Go parses', () => {
        expect(read('0')).toBe(0);
        expect(read('42')).toBe(42);
        expect(read('+42')).toBe(42);
        expect(read('0x1F')).toBe(31);
        expect(read('0b101')).toBe(5);
        expect(read('1_000')).toBe(1000);
    });

    it('reads a number Go cannot parse as an integer as a float, and anything else as a string', () => {
        expect(read('08')).toBe(8);
        expect(read('12e3')).toBe(12000);
        expect(read('0.5')).toBe(0.5);
        expect(read('.5')).toBe(0.5);
        expect(read('.inf')).toBe(Number.POSITIVE_INFINITY);
        expect(read('-.Inf')).toBe(Number.NEGATIVE_INFINITY);
        expect(read('.nan')).toBeNaN();
        expect(read('1:20')).toBe('1:20');
        expect(read('2024-01-01')).toBe('2024-01-01');
        expect(read('0x')).toBe('0x');
        expect(read('1.2.3')).toBe('1.2.3');
    });

    it('reads the YAML 1.1 booleans go-yaml knows', () => {
        for (const yes of ['y', 'Y', 'yes', 'Yes', 'YES', 'true', 'True', 'TRUE', 'on', 'On', 'ON']) {
            expect(read(yes)).toBe(true);
        }
        for (const no of ['n', 'N', 'no', 'No', 'NO', 'false', 'False', 'FALSE', 'off', 'Off', 'OFF']) {
            expect(read(no)).toBe(false);
        }
        expect(read('yEs')).toBe('yEs');
    });

    it('leaves quoted scalars strings and reads nulls and merge keys', () => {
        expect(read('"0755"')).toBe('0755');
        expect(read("'yes'")).toBe('yes');
        expect(read('~')).toBeNull();
        expect(read('null')).toBeNull();
        expect(read('')).toBeNull();
        expect(loadRenderedYaml('base: &b\n  a: 1\nmore:\n  <<: *b\n  c: 2\n')).toEqual({
            base: { a: 1 },
            more: { a: 1, c: 2 },
        });
    });

    it('honours explicit tags', () => {
        expect(read('!!str 0755')).toBe('0755');
        expect(read('!!int 0755')).toBe(0o755);
    });
});

describe('loadAllRenderedYaml', () => {
    it('reads every document with the same rules', () => {
        expect(loadAllRenderedYaml('a: 0644\n---\nb: on\n')).toEqual([{ a: 0o644 }, { b: true }]);
    });
});
