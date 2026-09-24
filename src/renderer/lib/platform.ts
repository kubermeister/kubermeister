import type { ShortcutPlatform } from '../../shared/shortcuts';

/** Renderer-side OS detection for OS-specific affordances, such as which modifier a shortcut uses. */
export const isMac = /mac/i.test(navigator.platform || navigator.userAgent);

/** The platform the shortcut table is read for: `Mod` is ⌘ on macOS and Ctrl elsewhere. */
export const shortcutPlatform: ShortcutPlatform = isMac ? 'mac' : 'other';
