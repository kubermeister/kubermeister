import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * How long a `findBy` waits for something to appear. The default second is enough for a laptop and
 * not for a CI runner mounting a whole screen under coverage instrumentation, where a correct test
 * fails on how fast the machine is rather than on what it rendered. Nothing here asserts a
 * duration, so the wait is only a ceiling on a query that will never be answered; a genuinely
 * missing element costs this long to report instead of a second, which only a failing run pays.
 */
configure({ asyncUtilTimeout: 10_000 });

// jsdom lacks the layout and pointer APIs the Radix and cmdk primitives call when they open.
/**
 * jsdom never resizes anything, so an observer that stays silent leaves every size-aware component
 * believing it has no room. This one answers once per observed element with the stand-in viewport
 * below, which is what lets the virtualised log console mount rows under test.
 */
class ResizeObserverStub {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
        this.callback(
            [{ target, contentRect: { ...VIEWPORT } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
        );
    }
    unobserve() {}
    disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
/**
 * jsdom lays nothing out, so every element reports an offset size of zero and anything that renders
 * only what fits on screen — the virtualised log console — renders nothing at all. These stand in
 * for layout; no test asserts on real geometry, which jsdom never had.
 */
const VIEWPORT = { width: 900, height: 600 };
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: VIEWPORT.width });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: VIEWPORT.height });

Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};

// CodeMirror measures its document through Range geometry, which jsdom does not implement.
const emptyRectList = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as DOMRectList;
Range.prototype.getClientRects ??= emptyRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

afterEach(() => cleanup());
