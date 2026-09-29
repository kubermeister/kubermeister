import { describe, expect, it } from 'vitest';
import { isExternalWebUrl, isInternalNavigation } from '../../../src/main/security';

describe('isExternalWebUrl', () => {
    it('accepts http and https only', () => {
        expect(isExternalWebUrl('https://example.com/docs')).toBe(true);
        expect(isExternalWebUrl('http://localhost:8080')).toBe(true);
    });

    it('rejects every other scheme and malformed input', () => {
        for (const url of [
            'file:///etc/passwd',
            'javascript:alert(1)',
            'kubermeister://open',
            'ftp://x',
            'not a url',
            '',
        ]) {
            expect(isExternalWebUrl(url)).toBe(false);
        }
    });
});

describe('isInternalNavigation', () => {
    const index = 'file:///Applications/Kubermeister.app/Contents/Resources/app/out/renderer/index.html';

    it('allows only the dev server origin while developing', () => {
        const dev = 'http://localhost:5173/';
        expect(isInternalNavigation('http://localhost:5173/#/pods', dev, index)).toBe(true);
        expect(isInternalNavigation('http://localhost:5174/', dev, index)).toBe(false);
        expect(isInternalNavigation('https://example.com', dev, index)).toBe(false);
        expect(isInternalNavigation(index, dev, index)).toBe(false);
    });

    it('allows the packaged index file with any hash route', () => {
        expect(isInternalNavigation(index, undefined, index)).toBe(true);
        expect(isInternalNavigation(`${index}#/workloads/pods`, undefined, index)).toBe(true);
    });

    it('refuses every other file, such as one dropped on the window', () => {
        for (const url of [
            'file:///Users/me/Downloads/dropped.html',
            'file:///Users/me/deployment.yaml',
            'file:///Applications/Kubermeister.app/Contents/Resources/app/out/renderer/other.html',
            'file:///Applications/Kubermeister.app/Contents/Resources/app/out/renderer/',
            `${index}?x=1`,
            'file:///',
        ]) {
            expect(isInternalNavigation(url, undefined, index)).toBe(false);
        }
    });

    it('refuses other schemes and malformed input when packaged', () => {
        expect(isInternalNavigation('http://localhost:5173/', undefined, index)).toBe(false);
        expect(isInternalNavigation('https://example.com', undefined, index)).toBe(false);
        expect(isInternalNavigation('not a url', undefined, index)).toBe(false);
    });
});
