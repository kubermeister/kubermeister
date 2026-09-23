import { z } from 'zod';
import {
    DEFAULT_SETTINGS,
    isStateKey,
    SECTION_SCHEMAS,
    SETTINGS_SCHEMA_URL,
    SETTINGS_SECTIONS,
    SETTINGS_VERSION,
    type SettingsSection,
} from './settings.js';

/**
 * The JSON Schema published for the settings file, derived from the very zod schemas the app reads
 * the file with, so an editor's idea of a valid file and the app's cannot drift apart. It covers
 * only what belongs in the file: the keys the app records about itself are left out, and every key
 * is optional, carrying the default a missing one takes.
 */

/** What each section is for, shown by an editor over the section's key. */
const SECTION_DESCRIPTIONS: Record<SettingsSection, string> = {
    general: 'Preferences about the app itself rather than about a cluster.',
    session: 'What the app opens on.',
    connection: 'Which kubeconfig the app reads.',
    data: 'How often screens refresh, how long a cluster read may take, and how much a console keeps.',
    updates: 'How far the updater goes on its own.',
    network: 'How cluster traffic reaches the API server.',
    charts: 'Helm chart repositories and OCI registries.',
    window: 'Where the window stands; recorded by the app itself, never in this file.',
};

/** What each key does; every key the file may carry must have one, which a test holds to. */
export const KEY_DESCRIPTIONS: Record<string, string> = {
    'general.confirmQuit':
        'Ask before quitting, since quitting ends every port forward, shell session, log follow and drain at once.',
    'session.restoreOnLaunch':
        "Reopen on the context and namespace last used; when false, follow the kubeconfig's current-context.",
    'connection.kubeconfigPath': 'The kubeconfig file to read; null reads $KUBECONFIG or ~/.kube/config.',
    'data.refreshIntervalSec': 'Seconds between polls of the live lists, metrics and the dashboard.',
    'data.readTimeoutSec': 'Seconds one cluster read may take before it is reported as timed out.',
    'data.logBufferLines': 'Log lines a live follow keeps before dropping the oldest.',
    'data.terminalFontSize': 'Font size of the shell terminals, in points.',
    'updates.mode':
        '"check" finds new versions and asks before downloading, "download" fetches them in the background, "off" checks only when asked; null follows the default, which is "download".',
    'updates.checkIntervalHours': 'Hours between scheduled update checks.',
    'network.proxyMode':
        '"env" follows HTTPS_PROXY, HTTP_PROXY and NO_PROXY the way kubectl does, "manual" uses proxyUrl, "off" connects directly. A context whose kubeconfig sets proxy-url always uses that.',
    'network.proxyUrl': 'The proxy used under "manual", as an http, https or socks URL; null means none.',
    'network.noProxy': 'Hosts that never go through a proxy, spelled as NO_PROXY spells them; null follows NO_PROXY.',
    'network.caBundlePath':
        'A PEM file of extra certificate authorities to trust for cluster TLS, added to the ones already trusted.',
    'charts.repositories':
        'Chart sources: a classic repository by its https URL, or an OCI registry by oci://host. Credentials are added in Settings and kept in the system keychain, never here.',
};

type JsonSchema = Record<string, unknown>;

function schemaOf(type: z.ZodType): JsonSchema {
    const { $schema: _dialect, ...schema } = z.toJSONSchema(type, { io: 'input', unrepresentable: 'any' });
    return schema;
}

/** The keys of a section the settings file carries: all of them but the ones the app records. */
export function fileKeys(section: SettingsSection): string[] {
    return Object.keys(SECTION_SCHEMAS[section].shape).filter((key) => !isStateKey(section, key));
}

export function settingsJsonSchema(): JsonSchema {
    const sections: Record<string, JsonSchema> = {};
    for (const section of SETTINGS_SECTIONS) {
        const keys = fileKeys(section);
        if (keys.length === 0) continue;
        const shape: Record<string, z.ZodType> = SECTION_SCHEMAS[section].shape;
        const defaults: Record<string, unknown> = DEFAULT_SETTINGS[section];
        const properties = Object.fromEntries(
            keys.map((key) => [
                key,
                {
                    description: KEY_DESCRIPTIONS[`${section}.${key}`],
                    ...schemaOf(shape[key] as z.ZodType),
                    default: defaults[key],
                },
            ]),
        );
        sections[section] = {
            description: SECTION_DESCRIPTIONS[section],
            type: 'object',
            properties,
            additionalProperties: false,
        };
    }
    return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: SETTINGS_SCHEMA_URL,
        title: 'Kubermeister settings',
        description:
            'The settings file, ~/.config/kubermeister/settings.json. Every key is optional; a missing one takes its default.',
        type: 'object',
        properties: {
            $schema: { description: 'This schema, for editors.', type: 'string' },
            version: {
                description: 'The shape the file is written in. Optional; the app adds it when it first saves.',
                const: SETTINGS_VERSION,
            },
            ...sections,
        },
        additionalProperties: false,
    };
}
