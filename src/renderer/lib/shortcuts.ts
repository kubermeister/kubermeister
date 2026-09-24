import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { matchShortcut, type Chord, type ShortcutId, type ShortcutPlatform } from '../../shared/shortcuts';
import { subscribe } from './ipc';
import { DOMAINS } from './nav';
import { shortcutPlatform } from './platform';
import { refreshScreen } from './refresh';

/** Where keyboard focus is, as far as the shortcut rules care. */
export type FocusZone = 'terminal' | 'editor' | 'text' | 'none';

export function focusZone(target: EventTarget | null): FocusZone {
    if (!(target instanceof Element)) return 'none';
    // xterm and CodeMirror both type through an element of their own inside their root.
    if (target.closest('.xterm')) return 'terminal';
    if (target.closest('.cm-editor')) return 'editor';
    if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return 'text';
    return 'none';
}

/**
 * Whether a matched chord may act where focus is.
 *
 * - A single key (`/`, `?`) is typing anywhere text goes, so it acts only outside every field.
 * - A terminal keeps every key a shell could read: Ctrl and Alt chords are the shell's on every
 *   platform, which leaves only ⌘ chords on macOS acting over it.
 * - The YAML editor keeps the chords it binds itself.
 */
export function chordAllowed(chord: Chord, zone: FocusZone, platform: ShortcutPlatform): boolean {
    if ('char' in chord) return zone === 'none';
    if (zone === 'terminal') {
        const shellModifier = platform === 'mac' ? chord.ctrl || chord.alt : chord.mod || chord.alt;
        return !shellModifier;
    }
    if (zone === 'editor') return !chord.editorOwns;
    return true;
}

/**
 * A dialog, popover, menu or listbox on screen has `Escape` and its own keys first, so while one is
 * open nothing is dispatched except closing the palette with the key that opened it.
 */
export function overlayOpen(root: ParentNode = document): boolean {
    return !!root.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
}

/** Marks a screen's search box, which `/` and `Mod+F` focus. */
export const SCREEN_SEARCH = { 'data-screen-search': '' } as const;

/** Focus the screen's visible search box; false when the screen has none. */
export function focusScreenSearch(root: ParentNode = document): boolean {
    const box = [...root.querySelectorAll<HTMLInputElement>('[data-screen-search]')].find(
        (el) => !el.closest('[hidden], [inert]'),
    );
    if (!box) return false;
    box.focus();
    box.select();
    return true;
}

export interface ShortcutHandlers {
    paletteOpen: boolean;
    togglePalette: () => void;
    openCheatSheet: () => void;
}

/**
 * The app's one `keydown` listener. It reads the shortcut table, applies the focus rules and acts;
 * a menu item for a key handled here pushes `shortcut` with the same id, so a click takes the same
 * path as the key. Keys the menu handles itself (Force Reload, Close, Quit) are left to it.
 */
export function useShortcuts(handlers: ShortcutHandlers): void {
    const router = useRouter();
    const queryClient = useQueryClient();
    const latest = useRef(handlers);
    useEffect(() => {
        latest.current = handlers;
    });

    useEffect(() => {
        const navigate = (to: string) => void router.navigate({ to });
        const run = (id: ShortcutId): boolean => {
            const { togglePalette, openCheatSheet } = latest.current;
            if (id.startsWith('domain.')) {
                const domain = DOMAINS.find((d) => `domain.${d.id}` === id);
                const first = domain?.groups[0]?.items[0];
                if (!first) return false;
                navigate(first.path);
                return true;
            }
            switch (id) {
                case 'palette':
                    togglePalette();
                    return true;
                case 'cheatSheet':
                    openCheatSheet();
                    return true;
                case 'settings':
                    navigate('/settings');
                    return true;
                case 'refresh':
                    void refreshScreen(queryClient);
                    return true;
                case 'search':
                    return focusScreenSearch();
                case 'back':
                    router.history.back();
                    return true;
                case 'forward':
                    router.history.forward();
                    return true;
                default:
                    return false;
            }
        };

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.repeat) return;
            const match = matchShortcut(event, shortcutPlatform);
            if (!match || match.shortcut.handler !== 'renderer') return;
            if (overlayOpen() && !(match.shortcut.id === 'palette' && latest.current.paletteOpen)) return;
            if (!chordAllowed(match.chord, focusZone(event.target), shortcutPlatform)) return;
            if (run(match.shortcut.id)) event.preventDefault();
        };
        // The mouse's back and forward buttons walk the same history as the keys.
        const onMouseUp = (event: MouseEvent) => {
            if (event.button !== 3 && event.button !== 4) return;
            event.preventDefault();
            run(event.button === 3 ? 'back' : 'forward');
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('mouseup', onMouseUp);
        const unsubscribe = subscribe('shortcut', ({ id }) => void run(id));
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('mouseup', onMouseUp);
            unsubscribe();
        };
    }, [router, queryClient]);
}
