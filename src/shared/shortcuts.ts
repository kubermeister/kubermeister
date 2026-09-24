/**
 * Every keyboard shortcut the app has, as one table read by the renderer's key dispatcher, the
 * cheat sheet and the application menu, so the three cannot disagree about a key.
 *
 * Pure data and pure functions: this module is compiled for main and the renderer alike, so it
 * touches neither the DOM nor Node.
 */

/** macOS, where `Mod` is ⌘, or Windows and Linux, where it is Ctrl. */
export type ShortcutPlatform = 'mac' | 'other';

export type ShortcutGroup = 'Navigation' | 'Screen' | 'App';

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['Navigation', 'Screen', 'App'];

/**
 * One key combination. A chord with modifiers names the key by its position (`KeyboardEvent.code`)
 * so Caps Lock and non-Latin layouts still trigger it. A single printable key (`char`) is matched by
 * the character it types instead, since `?` sits on a different key on every layout.
 */
export type Chord =
    | {
          code: string;
          /** ⌘ on macOS, Ctrl elsewhere. */
          mod?: boolean;
          /** The Control key on macOS, where it is not `Mod`. */
          ctrl?: boolean;
          shift?: boolean;
          alt?: boolean;
          /**
           * The YAML editor binds this chord itself and keeps it while it has focus. Held to
           * CodeMirror's own keymaps by the tests, so a chord the editor does not bind is never
           * withheld from the app.
           */
          editorOwns?: boolean;
      }
    | { char: string };

/**
 * The positions on the ANSI layout the chords here use, for showing and for menu accelerators. The
 * dispatcher never reads this; it compares codes.
 */
const CODE_LABELS: Record<string, { key: string; accelerator: string }> = {
    BracketLeft: { key: '[', accelerator: '[' },
    BracketRight: { key: ']', accelerator: ']' },
    Comma: { key: ',', accelerator: ',' },
    ArrowLeft: { key: '←', accelerator: 'Left' },
    ArrowRight: { key: '→', accelerator: 'Right' },
};

export type ShortcutId =
    | 'palette'
    | `domain.${DomainShortcutId}`
    | 'back'
    | 'forward'
    | 'refresh'
    | 'forceReload'
    | 'search'
    | 'settings'
    | 'cheatSheet'
    | 'closeWindow'
    | 'quit';

/**
 * The domains `Mod+1` to `Mod+6` go to, in the sidebar's order. The renderer's `DOMAINS` is the
 * authority on that order; a test holds this list to it.
 */
export const DOMAIN_SHORTCUT_IDS = ['overview', 'workloads', 'network', 'storage', 'access', 'addons'] as const;
export type DomainShortcutId = (typeof DOMAIN_SHORTCUT_IDS)[number];

export interface Shortcut {
    id: ShortcutId;
    label: string;
    group: ShortcutGroup;
    /** An empty list means the platform has no key for it. The first chord is the one menus show. */
    keys: Record<ShortcutPlatform, Chord[]>;
    /**
     * Who acts on the key. `renderer` keys are dispatched by the page, so the menu item beside them
     * shows the key without registering it and a focused terminal can keep it; `menu` keys are the
     * menu's own accelerator, which runs whether or not a page is there to answer.
     */
    handler: 'renderer' | 'menu';
}

const both = (...chords: Chord[]): Record<ShortcutPlatform, Chord[]> => ({ mac: chords, other: chords });

const domainShortcut = (id: DomainShortcutId, index: number, label: string): Shortcut => ({
    id: `domain.${id}`,
    label: `Go to ${label}`,
    group: 'Navigation',
    keys: both({ code: `Digit${index + 1}`, mod: true }),
    handler: 'renderer',
});

export const SHORTCUTS: readonly Shortcut[] = [
    {
        id: 'palette',
        label: 'Open or close the command palette',
        group: 'App',
        // Either modifier has always opened the palette on macOS, but Control+K there is also the
        // editor's delete-to-line-end, which it keeps.
        keys: {
            mac: [
                { code: 'KeyK', mod: true },
                { code: 'KeyK', ctrl: true, editorOwns: true },
            ],
            other: [{ code: 'KeyK', mod: true }],
        },
        handler: 'renderer',
    },
    ...DOMAIN_SHORTCUT_IDS.map((id, index) =>
        domainShortcut(id, index, ['Overview', 'Workloads', 'Network', 'Storage', 'Access', 'Add-ons'][index]!),
    ),
    {
        id: 'back',
        label: 'Go back',
        group: 'Navigation',
        keys: {
            mac: [{ code: 'BracketLeft', mod: true, editorOwns: true }],
            other: [{ code: 'ArrowLeft', alt: true, editorOwns: true }],
        },
        handler: 'renderer',
    },
    {
        id: 'forward',
        label: 'Go forward',
        group: 'Navigation',
        keys: {
            mac: [{ code: 'BracketRight', mod: true, editorOwns: true }],
            other: [{ code: 'ArrowRight', alt: true, editorOwns: true }],
        },
        handler: 'renderer',
    },
    {
        id: 'refresh',
        label: "Refresh the screen's data",
        group: 'Screen',
        keys: both({ code: 'KeyR', mod: true }),
        handler: 'renderer',
    },
    {
        id: 'search',
        label: "Focus the screen's search box",
        group: 'Screen',
        keys: both({ char: '/' }, { code: 'KeyF', mod: true, editorOwns: true }),
        handler: 'renderer',
    },
    {
        id: 'settings',
        label: 'Open Settings',
        group: 'App',
        keys: both({ code: 'Comma', mod: true }),
        handler: 'renderer',
    },
    {
        id: 'cheatSheet',
        label: 'Show keyboard shortcuts',
        group: 'App',
        keys: both({ char: '?' }),
        handler: 'renderer',
    },
    {
        id: 'forceReload',
        label: 'Reload the window, ending every forward, shell and log follow',
        group: 'App',
        keys: both({ code: 'KeyR', mod: true, shift: true }),
        handler: 'menu',
    },
    {
        id: 'closeWindow',
        label: 'Close the window, which quits after asking',
        group: 'App',
        // macOS has no Close item; there the window's own button hides it and the app runs on.
        keys: { mac: [], other: [{ code: 'KeyW', mod: true }] },
        // The Close role's own, so the close runs through the window's close guard.
        handler: 'menu',
    },
    {
        id: 'quit',
        label: 'Quit, after asking',
        group: 'App',
        keys: { mac: [{ code: 'KeyQ', mod: true }], other: [] },
        handler: 'menu',
    },
];

export function shortcutById(id: ShortcutId): Shortcut {
    return SHORTCUTS.find((s) => s.id === id)!;
}

/** What a key event carries that a chord is matched on, so matching needs no DOM type. */
export interface KeyInput {
    key: string;
    code: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
}

export function chordMatches(chord: Chord, input: KeyInput, platform: ShortcutPlatform): boolean {
    if ('char' in chord) {
        // Shift is how `?` is typed on most layouts, so it is not a modifier here.
        return input.key === chord.char && !input.metaKey && !input.ctrlKey && !input.altKey;
    }
    const mod = platform === 'mac' ? input.metaKey : input.ctrlKey;
    // Outside macOS the Windows or Super key is never part of a shortcut.
    const other = platform === 'mac' ? input.ctrlKey : input.metaKey;
    return (
        input.code === chord.code &&
        mod === !!chord.mod &&
        other === (platform === 'mac' && !!chord.ctrl) &&
        input.shiftKey === !!chord.shift &&
        input.altKey === !!chord.alt
    );
}

/** The shortcut and the chord a key event is, if any. */
export function matchShortcut(
    input: KeyInput,
    platform: ShortcutPlatform,
): { shortcut: Shortcut; chord: Chord } | undefined {
    for (const shortcut of SHORTCUTS) {
        const chord = shortcut.keys[platform].find((c) => chordMatches(c, input, platform));
        if (chord) return { shortcut, chord };
    }
    return undefined;
}

function keyLabel(code: string): { key: string; accelerator: string } {
    const known = CODE_LABELS[code];
    if (known) return known;
    const letter = /^(?:Key|Digit)(.)$/.exec(code)?.[1];
    return { key: letter ?? code, accelerator: letter ?? code };
}

/** A chord as the platform writes it: `⇧⌘R` on macOS, `Ctrl+Shift+R` elsewhere. */
export function formatChord(chord: Chord, platform: ShortcutPlatform): string {
    if ('char' in chord) return chord.char;
    const { key } = keyLabel(chord.code);
    if (platform === 'mac') {
        return `${chord.ctrl ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.mod ? '⌘' : ''}${key}`;
    }
    return [chord.mod && 'Ctrl', chord.shift && 'Shift', chord.alt && 'Alt', key].filter(Boolean).join('+');
}

/** A chord as an Electron menu accelerator string. */
export function chordAccelerator(chord: Chord, platform: ShortcutPlatform): string {
    if ('char' in chord) return chord.char;
    const modifier = platform === 'mac' ? 'Cmd' : 'Ctrl';
    return [
        chord.ctrl && 'Ctrl',
        chord.mod && modifier,
        chord.alt && 'Alt',
        chord.shift && 'Shift',
        keyLabel(chord.code).accelerator,
    ]
        .filter(Boolean)
        .join('+');
}

export function platformOf(os: string): ShortcutPlatform {
    return os === 'darwin' ? 'mac' : 'other';
}
