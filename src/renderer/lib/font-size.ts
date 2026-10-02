import { useSyncExternalStore } from 'react';

/**
 * How large the app's type reads. It is a preference about one window, like the theme, and it has
 * to apply before the first paint or every screen would visibly jump once the settings file
 * answered, so it lives in `localStorage` beside the theme rather than in the settings file.
 *
 * It scales the type tokens alone (`--font-scale` in `globals.css`), never spacing or icons, so it is
 * a different control from Electron's zoom, which the View menu and the OS shortcuts already drive.
 * The steps are fixed rather than free, so every size is one the list densities were looked at in.
 */
const KEY = 'km-font-size';

export const FONT_SIZES = [
    { id: 'small', label: 'Small', scale: 0.92 },
    { id: 'default', label: 'Default', scale: 1 },
    { id: 'large', label: 'Large', scale: 1.08 },
    { id: 'larger', label: 'Larger', scale: 1.16 },
] as const;

export type FontSize = (typeof FONT_SIZES)[number]['id'];

export const DEFAULT_FONT_SIZE: FontSize = 'default';

function isFontSize(value: string | null): value is FontSize {
    return FONT_SIZES.some((size) => size.id === value);
}

export function readFontSize(): FontSize {
    try {
        const stored = localStorage.getItem(KEY);
        return isFontSize(stored) ? stored : DEFAULT_FONT_SIZE;
    } catch {
        // Private windows and blocked site data throw on access; the app must still render.
        return DEFAULT_FONT_SIZE;
    }
}

export function fontScaleOf(size: FontSize): number {
    return FONT_SIZES.find((step) => step.id === size)?.scale ?? 1;
}

/** Puts the size on the document root, where every type token reads it. */
export function applyFontSize(size: FontSize): void {
    document.documentElement.style.setProperty('--font-scale', String(fontScaleOf(size)));
}

let current: FontSize | null = null;
const listeners = new Set<() => void>();

export function fontSize(): FontSize {
    current ??= readFontSize();
    return current;
}

export function setFontSize(size: FontSize): void {
    current = size;
    try {
        localStorage.setItem(KEY, size);
    } catch {
        // Nothing to do: the choice simply will not survive this window.
    }
    applyFontSize(size);
    for (const listener of listeners) listener();
}

/** Forget the copy in memory and read storage again; the way a test starts from nothing. */
export function resetFontSize(): void {
    current = null;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useFontSize() {
    return [useSyncExternalStore(subscribe, fontSize), setFontSize] as const;
}
