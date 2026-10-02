import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    applyFontSize,
    DEFAULT_FONT_SIZE,
    fontScaleOf,
    fontSize,
    readFontSize,
    resetFontSize,
    setFontSize,
    useFontSize,
} from '@/lib/font-size';

describe('font size', () => {
    beforeEach(() => {
        localStorage.clear();
        resetFontSize();
        document.documentElement.style.removeProperty('--font-scale');
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('starts at the default, which is the scale the tokens were written at', () => {
        expect(readFontSize()).toBe(DEFAULT_FONT_SIZE);
        expect(fontScaleOf(DEFAULT_FONT_SIZE)).toBe(1);
    });

    it('reads a stored step and refuses one this version does not offer', () => {
        localStorage.setItem('km-font-size', 'larger');
        expect(readFontSize()).toBe('larger');
        localStorage.setItem('km-font-size', 'huge');
        expect(readFontSize()).toBe('default');
    });

    it('still answers when storage throws, as a private window does', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('denied');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('denied');
        });
        expect(readFontSize()).toBe('default');
        expect(() => setFontSize('small')).not.toThrow();
        expect(fontSize()).toBe('small');
    });

    it('puts the scale on the document root, where every type token reads it', () => {
        applyFontSize('small');
        expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('0.92');
    });

    it('stores, applies and tells every reader of a change', () => {
        const { result } = renderHook(() => useFontSize());
        expect(result.current[0]).toBe('default');
        act(() => result.current[1]('large'));
        expect(result.current[0]).toBe('large');
        expect(localStorage.getItem('km-font-size')).toBe('large');
        expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.08');
    });
});
