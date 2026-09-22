import { DEFAULT_SETTINGS, mergeSettings, type Settings, type SettingsPatch } from '../../../src/shared/settings';

/**
 * A whole `Settings` answer for a mocked `settings.get`.
 *
 * Main validates both directions of every channel, so a screen reads its sections without
 * guarding and a hand-written partial fails it for a reason no running app could produce: a
 * fixture carrying no `network` section left the Settings screen throwing on `proxyMode`, which
 * the route's error boundary then swallowed into a warning nobody read. Building each fixture
 * from the defaults through the app's own merge keeps every section present as more are added,
 * and leaves the test naming only the values it is actually about.
 */
export function settingsFixture(patch: SettingsPatch = {}): Settings {
    return mergeSettings(structuredClone(DEFAULT_SETTINGS), patch);
}
