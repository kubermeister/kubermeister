import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface Step {
    name?: string;
    if?: string;
    run?: string;
    uses?: string;
    env?: Record<string, string>;
}

interface Job {
    env?: Record<string, string>;
    steps?: Step[];
}

const template = readFileSync('packaging/aur/PKGBUILD.tmpl', 'utf8');

const release = load(readFileSync('.github/workflows/release.yml', 'utf8')) as { jobs: Record<string, Job> };
const publish = release.jobs.publish!;
const publishSteps = publish.steps ?? [];
const indexOf = (match: RegExp) => publishSteps.findIndex((step) => match.test(step.name ?? ''));
const aurStep = () => publishSteps[indexOf(/aur/i)];

const ci = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: Record<string, Job> };
const smokeSteps = ci.jobs.package?.steps ?? [];

/** The AUR's own Ed25519 host key, whose fingerprint aur.archlinux.org publishes on its home page. */
const AUR_HOST_KEY =
    'aur.archlinux.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEuBKrPzbawxA/k2g6NcyV5jmqwJ2s+zpgZGZ7tpLIcN';

describe('the AUR package template', () => {
    it('is the -bin package the AUR requires for a prebuilt binary', () => {
        expect(template).toMatch(/^pkgname=kubermeister-bin$/m);
        expect(template).toMatch(/^arch=\(x86_64 aarch64\)$/m);
    });

    it('repackages each architecture from the deb published for it', () => {
        const base = 'https://github.com/kubermeister/kubermeister/releases/download/v${pkgver}';
        expect(template).toMatch(/^source_x86_64=\(.*::/m);
        expect(template).toContain(`${base}/Kubermeister-\${pkgver}-linux-amd64.deb`);
        expect(template).toContain(`${base}/Kubermeister-\${pkgver}-linux-arm64.deb`);
        expect(template).toMatch(/^source_aarch64=\(/m);
    });

    it('carries every placeholder the release fills in', () => {
        for (const placeholder of ['__VERSION__', '__SHA256_X86_64__', '__SHA256_AARCH64__', '__SHA256_LICENSE__']) {
            expect(template).toContain(placeholder);
        }
    });

    it('depends on libsecret, through which safeStorage seals chart repository credentials', () => {
        const depends = /^depends=\(([^)]*)\)/m.exec(template)?.[1]?.split(/\s+/) ?? [];
        expect(depends).toContain('libsecret');
    });

    it("repeats what the deb's postinst would have done, since extracting data.tar skips it", () => {
        const packageFn = /^package\(\) \{([\s\S]*?)^\}/m.exec(template)?.[1] ?? '';
        expect(packageFn).toContain('/usr/bin/kubermeister');
        expect(packageFn).toContain('/opt/Kubermeister/kubermeister');
        expect(packageFn).toMatch(/4755.*chrome-sandbox/);
    });
});

describe('publishing the AUR package', () => {
    it('runs only when the key is configured, so a release never blocks on it', () => {
        expect(publish.env?.HAS_AUR_KEY).toBe("${{ secrets.AUR_SSH_PRIVATE_KEY != '' }}");
        expect(aurStep()?.if).toBe("env.HAS_AUR_KEY == 'true'");
    });

    it('takes the digests the upload already verified rather than hashing the debs again', () => {
        // The same digests SHA256SUMS lists; the file itself does not survive the checkout.
        expect(indexOf(/aur/i)).toBeGreaterThan(indexOf(/checksum/i));
        expect(aurStep()?.run).toContain('.digest');
        expect(aurStep()?.run).not.toContain('gh release download');
    });

    it('pushes with plain git rather than an action that would hold the key', () => {
        expect(aurStep()?.uses).toBeUndefined();
        expect(aurStep()?.run).toContain('ssh://aur@aur.archlinux.org/kubermeister-bin.git');
        expect(aurStep()?.env?.AUR_SSH_PRIVATE_KEY).toBe('${{ secrets.AUR_SSH_PRIVATE_KEY }}');
    });

    it('trusts the host key it was written with, never one scanned at run time', () => {
        expect(aurStep()?.run).toContain(AUR_HOST_KEY);
        expect(aurStep()?.run).toContain('StrictHostKeyChecking=yes');
        expect(aurStep()?.run).not.toContain('ssh-keyscan');
    });
});

describe('the AUR package smoke', () => {
    it('builds, installs and starts the package from the deb this run built', () => {
        const step = smokeSteps.find((candidate) => /aur/i.test(candidate.name ?? ''));
        expect(step?.if).toBe("matrix.arch == 'x64'");
        expect(step?.run).toContain('packaging/aur/PKGBUILD.tmpl');
        expect(step?.run).toContain('makepkg');
        expect(step?.run).toContain('namcap');
    });
});
