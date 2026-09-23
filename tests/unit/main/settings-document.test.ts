import { describe, expect, it } from 'vitest';
import {
    configForWrite,
    configFromLegacy,
    detectIndent,
    patchDocument,
    serializeDocument,
    stateFromLegacy,
} from '../../../src/main/settings/document';
import { DEFAULT_SETTINGS, mergeSettings, SETTINGS_SCHEMA_URL } from '../../../src/shared/settings';

describe('patchDocument', () => {
    it('sets the keys a patch names in the file they belong to, keeping order and appending what is new', () => {
        const doc = { data: { logBufferLines: 10_000 }, future: 1 };
        const patch = { data: { refreshIntervalSec: 5, forwards: [] }, session: { lastContext: 'prod' } };
        expect(patchDocument(doc, patch, 'config')).toEqual({
            data: { logBufferLines: 10_000, refreshIntervalSec: 5 },
            future: 1,
        });
        expect(patchDocument({}, patch, 'state')).toEqual({ data: { forwards: [] }, session: { lastContext: 'prod' } });
    });

    it('answers null when nothing the file holds would change', () => {
        expect(patchDocument({ data: { refreshIntervalSec: 5 } }, { data: { refreshIntervalSec: 5 } }, 'config')).toBe(
            null,
        );
        expect(patchDocument({}, { session: { lastContext: 'prod' } }, 'config')).toBe(null);
        expect(patchDocument({}, {}, 'state')).toBe(null);
    });

    it('writes a value equal to its default when somebody sets it, since setting it is the choice', () => {
        expect(patchDocument({}, { data: { refreshIntervalSec: 12 } }, 'config')).toEqual({
            data: { refreshIntervalSec: 12 },
        });
    });

    it('replaces a section that is not an object rather than spreading it', () => {
        expect(patchDocument({ general: 'on' }, { general: { confirmQuit: false } }, 'config')).toEqual({
            general: { confirmQuit: false },
        });
    });
});

describe('configForWrite', () => {
    it('stamps the current version first, keeps $schema, and drops state keys and emptied sections', () => {
        const doc = {
            data: { forwards: [], refreshIntervalSec: 5 },
            window: { bounds: null },
            $schema: './schema.json',
            version: 1,
            future: { flag: true },
        };
        const written = configForWrite(doc);
        expect(written).toEqual({
            $schema: './schema.json',
            version: 2,
            data: { refreshIntervalSec: 5 },
            future: { flag: true },
        });
        expect(Object.keys(written)).toEqual(['$schema', 'version', 'data', 'future']);
    });
});

describe('moving a whole-object file over', () => {
    const legacy = mergeSettings(DEFAULT_SETTINGS, {
        session: { lastContext: 'prod', restoreOnLaunch: false },
        data: { readTimeoutSec: 300 },
        updates: { mode: 'off' },
    });

    it('keeps in the settings file only what differs from the defaults', () => {
        expect(configFromLegacy(legacy)).toEqual({
            $schema: SETTINGS_SCHEMA_URL,
            version: 2,
            session: { restoreOnLaunch: false },
            data: { readTimeoutSec: 300 },
            updates: { mode: 'off' },
        });
        expect(configFromLegacy(DEFAULT_SETTINGS)).toEqual({ $schema: SETTINGS_SCHEMA_URL, version: 2 });
    });

    it('carries every state key into the state file', () => {
        expect(stateFromLegacy(legacy)).toEqual({
            session: { lastContext: 'prod', lastNamespace: null },
            data: { forwards: [] },
            window: { bounds: null },
        });
    });
});

describe('indentation', () => {
    it('keeps the indentation a file already uses and defaults to four spaces', () => {
        expect(detectIndent('{\n  "a": 1\n}')).toBe('  ');
        expect(detectIndent('{\n\t"a": 1\n}')).toBe('\t');
        expect(detectIndent('{"a":1}')).toBe('    ');
        expect(detectIndent('')).toBe('    ');
    });

    it('ends the file with a newline', () => {
        expect(serializeDocument({ a: 1 }, '  ')).toBe('{\n  "a": 1\n}\n');
    });
});
