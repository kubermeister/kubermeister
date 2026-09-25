import { readFileSync } from 'node:fs';
import { Arch, getArtifactArchName } from 'builder-util';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const config = load(readFileSync('electron-builder.yml', 'utf8')) as {
    electronFuses?: Record<string, boolean>;
    mac?: { hardenedRuntime?: boolean };
    extraResources?: { from: string; to: string }[];
    toolsets?: { appimage?: string };
    protocols?: { name: string; schemes: string[] }[];
    productName?: string;
    artifactName?: string;
    linux?: { target?: (string | { target: string; arch?: string[] })[] };
};

interface Workflow {
    jobs: Record<string, { 'runs-on'?: string; strategy?: { matrix?: Record<string, unknown> } }>;
}

const workflow = (path: string) => load(readFileSync(path, 'utf8')) as Workflow;

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

describe('the AppImage runtime', () => {
    it('is pinned away from the default, whose runtime needs a library Ubuntu dropped', () => {
        // electron-builder defaults `toolsets.appimage` to '0.0.0', the legacy toolset: that runtime
        // dlopens libfuse.so.2, absent from Ubuntu since 23.10, and the AppImage dies at launch.
        expect(config.toolsets?.appimage).toBeDefined();
        expect(config.toolsets?.appimage).not.toBe('0.0.0');
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

describe('electron-builder protocols', () => {
    it('registers the scheme links are written in, for every platform at once', async () => {
        const { DEEP_LINK_SCHEME } = await import('../../../src/shared/deep-link');
        // Top level rather than per platform, which is what also puts the scheme in the Linux
        // desktop entry's MimeType.
        expect(config.protocols).toEqual([{ name: 'Kubermeister link', schemes: [DEEP_LINK_SCHEME] }]);
    });
});

describe('the Linux packages', () => {
    /** The asset name electron-builder gives a Linux package, expanded the way it expands the pattern. */
    const assetName = (arch: Arch, ext: string) =>
        (config.artifactName ?? '')
            .replace('${productName}', config.productName ?? '')
            .replace('${version}', '1.2.3')
            .replace('${os}', 'linux')
            .replace('${arch}', getArtifactArchName(arch, ext))
            .replace('${ext}', ext);

    it('keeps the asset name pattern the release workflows, the updater and the website read', () => {
        expect(config.artifactName).toBe('${productName}-${version}-${os}-${arch}.${ext}');
    });

    it('names the packages of both architectures as they are published', () => {
        // The x64 names are what every release so far has published and the website links to; an
        // electron-builder that spelled an architecture differently would move them.
        expect(assetName(Arch.x64, 'AppImage')).toBe('Kubermeister-1.2.3-linux-x86_64.AppImage');
        expect(assetName(Arch.x64, 'deb')).toBe('Kubermeister-1.2.3-linux-amd64.deb');
        expect(assetName(Arch.arm64, 'AppImage')).toBe('Kubermeister-1.2.3-linux-arm64.AppImage');
        expect(assetName(Arch.arm64, 'deb')).toBe('Kubermeister-1.2.3-linux-arm64.deb');
        // The rpm spells both architectures the way rpm itself does, unlike the deb beside it.
        expect(assetName(Arch.x64, 'rpm')).toBe('Kubermeister-1.2.3-linux-x86_64.rpm');
        expect(assetName(Arch.arm64, 'rpm')).toBe('Kubermeister-1.2.3-linux-aarch64.rpm');
    });

    it('builds for the host alone, so no runner cross-builds the other architecture', () => {
        // A listed arch is built whatever the command line asks for.
        expect(config.linux?.target).toEqual(['AppImage', 'deb', 'rpm']);
    });

    it('is released from one native runner per architecture', () => {
        const matrix = workflow('.github/workflows/release.yml').jobs.package?.strategy?.matrix;
        expect(matrix?.os).toEqual(expect.arrayContaining(['ubuntu-latest', 'ubuntu-24.04-arm']));
    });

    it('is started by the package smoke on both architectures before any release', () => {
        const matrix = workflow('.github/workflows/ci.yml').jobs.package?.strategy?.matrix;
        expect(matrix?.include).toEqual([
            { runner: 'ubuntu-latest', arch: 'x64' },
            { runner: 'ubuntu-24.04-arm', arch: 'arm64' },
        ]);
    });
});
