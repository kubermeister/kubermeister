import { closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { foldKeymap } from '@codemirror/language';
import { lintKeymap } from '@codemirror/lint';
import { searchKeymap } from '@codemirror/search';
import type { KeyBinding } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { DOMAINS } from '../../../src/renderer/lib/nav.js';
import {
    chordAccelerator,
    DOMAIN_SHORTCUT_IDS,
    formatChord,
    matchShortcut,
    platformOf,
    SHORTCUTS,
    shortcutById,
    type Chord,
    type KeyInput,
    type ShortcutPlatform,
} from '../../../src/shared/shortcuts.js';

const PLATFORMS: ShortcutPlatform[] = ['mac', 'other'];

const key = (input: Partial<KeyInput>): KeyInput => ({
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...input,
});

/** What pressing a chord sends, on a US layout. */
function press(chord: Chord, platform: ShortcutPlatform): KeyInput {
    if ('char' in chord) return key({ key: chord.char, shiftKey: chord.char === '?' });
    const mod = !!chord.mod;
    return key({
        code: chord.code,
        metaKey: platform === 'mac' && mod,
        ctrlKey: platform === 'mac' ? !!chord.ctrl : mod,
        shiftKey: !!chord.shift,
        altKey: !!chord.alt,
    });
}

/** The keys the YAML editor binds: `basicSetup` plus the editor's own `indentWithTab`. */
const EDITOR_KEYMAP: readonly KeyBinding[] = [
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap,
    indentWithTab,
];

const CM_KEY_NAMES: Record<string, string> = {
    BracketLeft: '[',
    BracketRight: ']',
    Comma: ',',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
};

/** A CodeMirror key name reduced to a comparable form: modifiers resolved for the platform, sorted. */
function normalise(name: string, platform: ShortcutPlatform): string {
    const parts = name.split(/-(?!$)/);
    const last = parts.pop()!;
    const mods = parts.map((m) => {
        if (m === 'Mod') return platform === 'mac' ? 'Meta' : 'Ctrl';
        if (m === 'Cmd') return 'Meta';
        return m;
    });
    return [...new Set(mods)]
        .sort()
        .concat(last.length === 1 ? last.toLowerCase() : last)
        .join('-');
}

function editorBinds(chord: Chord, platform: ShortcutPlatform): boolean {
    if ('char' in chord) return false;
    const code = chord.code;
    const last = CM_KEY_NAMES[code] ?? code.replace(/^(Key|Digit)/, '').toLowerCase();
    const mods = [chord.mod && 'Mod', chord.ctrl && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift'].filter(Boolean);
    const wanted = normalise([...mods, last].join('-'), platform);
    const os = platform === 'mac' ? 'mac' : 'linux';
    return EDITOR_KEYMAP.some((binding) => {
        const name = binding[os] ?? (platform === 'other' ? binding.win : undefined) ?? binding.key;
        if (!name) return false;
        if (normalise(name, platform) === wanted) return true;
        return !!binding.shift && normalise(`Shift-${name}`, platform) === wanted;
    });
}

describe('the shortcut table', () => {
    it('gives no two shortcuts the same key on one platform', () => {
        for (const platform of PLATFORMS) {
            for (const shortcut of SHORTCUTS) {
                for (const chord of shortcut.keys[platform]) {
                    expect(matchShortcut(press(chord, platform), platform)?.shortcut.id).toBe(shortcut.id);
                }
            }
            const shown = SHORTCUTS.flatMap((s) => s.keys[platform].map((c) => formatChord(c, platform)));
            expect(new Set(shown).size).toBe(shown.length);
        }
    });

    it('numbers every sidebar domain, in the sidebar order', () => {
        expect(DOMAINS.map((d) => d.id)).toEqual([...DOMAIN_SHORTCUT_IDS]);
        DOMAIN_SHORTCUT_IDS.forEach((id, index) => {
            expect(shortcutById(`domain.${id}`).keys.mac).toEqual([{ code: `Digit${index + 1}`, mod: true }]);
            expect(shortcutById(`domain.${id}`).label).toBe(`Go to ${DOMAINS[index]!.label}`);
        });
    });

    it('withholds from the YAML editor exactly the chords it binds itself', () => {
        // A chord marked for the editor that CodeMirror does not bind would be taken from the app for
        // nothing; one it binds but is not marked would be taken from the editor.
        for (const platform of PLATFORMS) {
            for (const shortcut of SHORTCUTS) {
                for (const chord of shortcut.keys[platform]) {
                    if ('char' in chord) continue;
                    expect(
                        { id: shortcut.id, chord: formatChord(chord, platform), owned: editorBinds(chord, platform) },
                        `${shortcut.id} on ${platform}`,
                    ).toEqual({ id: shortcut.id, chord: formatChord(chord, platform), owned: !!chord.editorOwns });
                }
            }
        }
    });

    it('matches chords by position, exactly, and single keys by the character typed', () => {
        expect(matchShortcut(key({ code: 'KeyR', metaKey: true }), 'mac')?.shortcut.id).toBe('refresh');
        expect(matchShortcut(key({ code: 'KeyR', metaKey: true, shiftKey: true }), 'mac')?.shortcut.id).toBe(
            'forceReload',
        );
        // A Cyrillic layout types "к" on the K key; the palette still opens.
        expect(matchShortcut(key({ key: 'к', code: 'KeyK', ctrlKey: true }), 'other')?.shortcut.id).toBe('palette');
        // The Windows key is not Ctrl, and Ctrl is not ⌘.
        expect(matchShortcut(key({ code: 'KeyR', metaKey: true }), 'other')).toBeUndefined();
        expect(matchShortcut(key({ code: 'KeyR', ctrlKey: true }), 'mac')).toBeUndefined();
        expect(matchShortcut(key({ code: 'KeyR', ctrlKey: true, metaKey: true }), 'other')).toBeUndefined();
        // `?` is shifted on most layouts; with a modifier it is somebody else's key.
        expect(matchShortcut(key({ key: '?', shiftKey: true }), 'other')?.shortcut.id).toBe('cheatSheet');
        expect(matchShortcut(key({ key: '?', altKey: true }), 'other')).toBeUndefined();
        expect(matchShortcut(key({ key: 'r', code: 'KeyR' }), 'mac')).toBeUndefined();
    });

    it('writes keys the way each platform does, and as Electron accelerators', () => {
        const forceReload = shortcutById('forceReload').keys.mac[0]!;
        expect(formatChord(forceReload, 'mac')).toBe('⇧⌘R');
        expect(formatChord(forceReload, 'other')).toBe('Ctrl+Shift+R');
        expect(chordAccelerator(forceReload, 'mac')).toBe('Cmd+Shift+R');
        expect(chordAccelerator(forceReload, 'other')).toBe('Ctrl+Shift+R');
        expect(formatChord(shortcutById('back').keys.other[0]!, 'other')).toBe('Alt+←');
        expect(chordAccelerator(shortcutById('back').keys.other[0]!, 'other')).toBe('Alt+Left');
        expect(formatChord(shortcutById('back').keys.mac[0]!, 'mac')).toBe('⌘[');
        expect(formatChord(shortcutById('palette').keys.mac[1]!, 'mac')).toBe('⌃K');
        expect(chordAccelerator(shortcutById('settings').keys.other[0]!, 'other')).toBe('Ctrl+,');
        expect(formatChord(shortcutById('domain.storage').keys.other[0]!, 'other')).toBe('Ctrl+4');
        expect(chordAccelerator(shortcutById('cheatSheet').keys.mac[0]!, 'mac')).toBe('?');
        expect(chordAccelerator({ code: 'F5', alt: true }, 'other')).toBe('Alt+F5');
    });

    it('reads the platform from the OS name', () => {
        expect(platformOf('darwin')).toBe('mac');
        expect(platformOf('win32')).toBe('other');
        expect(platformOf('linux')).toBe('other');
    });
});
