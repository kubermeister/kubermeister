import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const config = load(readFileSync('electron-builder.yml', 'utf8')) as {
    electronFuses?: Record<string, boolean>;
    mac?: { hardenedRuntime?: boolean };
    extraResources?: { from: string; to: string }[];
};

describe('electron-builder fuses', () => {
    it('closes every way of running the packaged app as something other than the app', () => {
        expect(config.electronFuses).toMatchObject({
            runAsNode: false,
            enableNodeOptionsEnvironmentVariable: false,
            enableNodeCliInspectArguments: false,
        });
    });

    it('loads the app only from its own validated archive', () => {
        expect(config.electronFuses).toMatchObject({
            onlyLoadAppFromAsar: true,
            enableEmbeddedAsarIntegrityValidation: true,
            enableCookieEncryption: true,
        });
    });

    it('re-signs an unsigned build after flipping, so it still opens', () => {
        expect(config.electronFuses?.resetAdHocDarwinSignature).toBe(true);
    });

    it('leaves the file protocol privileges alone, since the renderer is a file:// document', () => {
        expect(config.electronFuses).not.toHaveProperty('grantFileProtocolExtraPrivileges');
    });

    it('keeps the hardened runtime on for signed macOS builds', () => {
        expect(config.mac?.hardenedRuntime).toBe(true);
    });
});

describe('extra resources', () => {
    it('ships the icon the Linux window sets on itself', () => {
        // `windowIcon` in src/main/window.ts resolves it under process.resourcesPath.
        expect(config.extraResources).toContainEqual({ from: 'resources/icon.png', to: 'icon.png' });
    });

    it('ships the notices redistributing Electron and Chromium requires', () => {
        expect(config.extraResources).toContainEqual({
            from: 'node_modules/electron/dist/LICENSE',
            to: 'LICENSE.electron.txt',
        });
        expect(config.extraResources).toContainEqual({
            from: 'node_modules/electron/dist/LICENSES.chromium.html',
            to: 'LICENSES.chromium.html',
        });
    });
});
