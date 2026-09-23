import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileKeys, KEY_DESCRIPTIONS, settingsJsonSchema } from '../../../src/shared/settings-schema';
import { SETTINGS_SCHEMA_URL, SETTINGS_SECTIONS } from '../../../src/shared/settings';

const SCHEMA_FILE = 'settings.schema.json';
const generated = `${JSON.stringify(settingsJsonSchema(), null, 2)}\n`;

// `npm run schema` runs this file in the `write` mode to bring the committed schema up to date.
if (import.meta.env.MODE === 'write') writeFileSync(SCHEMA_FILE, generated);

type Schema = { properties: Record<string, { properties?: Record<string, Record<string, unknown>> }> };
const schema = settingsJsonSchema() as Schema;

describe('the settings JSON Schema', () => {
    it('is committed as generated from the schemas the app reads the file with', () => {
        expect(readFileSync(SCHEMA_FILE, 'utf8'), 'run `npm run schema` to regenerate settings.schema.json').toBe(
            generated,
        );
    });

    it('is published at the address a file the app creates points to', () => {
        expect(SETTINGS_SCHEMA_URL.endsWith(`/main/${SCHEMA_FILE}`)).toBe(true);
    });

    it('describes every key the file may carry, and nothing else', () => {
        const keys = SETTINGS_SECTIONS.flatMap((section) => fileKeys(section).map((key) => `${section}.${key}`));
        expect(Object.keys(KEY_DESCRIPTIONS).sort()).toEqual(keys.sort());
    });

    it('leaves out what the app records about itself', () => {
        expect(schema.properties.window).toBeUndefined();
        expect(schema.properties.session?.properties).not.toHaveProperty('lastContext');
        expect(schema.properties.data?.properties).not.toHaveProperty('forwards');
    });

    it('carries each key’s bounds and the default a missing one takes', () => {
        expect(schema.properties.data?.properties?.readTimeoutSec).toMatchObject({
            type: 'integer',
            minimum: 5,
            maximum: 600,
            default: 60,
            description: expect.any(String),
        });
        expect(schema.properties.updates?.properties?.mode).toMatchObject({ default: null });
        expect(schema).toMatchObject({ additionalProperties: false, properties: { version: { const: 2 } } });
    });
});
