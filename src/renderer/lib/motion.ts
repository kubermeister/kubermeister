/**
 * Whether the OS asks for less motion. The stylesheet stops CSS animation on its own; this is for
 * motion drawn by code, such as the terminal's blinking cursor, which no media query reaches.
 */
export function prefersReducedMotion(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
