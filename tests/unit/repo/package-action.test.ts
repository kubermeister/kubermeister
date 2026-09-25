import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const nameAssets = resolve('.github/actions/package/name-assets.sh');
let dir = '';

interface Step {
    name?: string;
    run?: string;
    env?: Record<string, string>;
}

const action = load(readFileSync('.github/actions/package/action.yml', 'utf8')) as { runs: { steps: Step[] } };
const steps = action.runs.steps;
const indexOf = (match: RegExp) => steps.findIndex((step) => match.test(step.name ?? ''));

/** A release/ directory holding empty installers and feeds naming the given files. */
function release(installers: string[], feeds: Record<string, string[]>): void {
    mkdirSync(join(dir, 'release'));
    for (const name of installers) writeFileSync(join(dir, 'release', name), '');
    for (const [feed, named] of Object.entries(feeds)) {
        const files = named.map((name) => `  - url: ${name}\n    sha512: x\n    size: 1\n`).join('');
        writeFileSync(join(dir, 'release', feed), `version: 1.2.3\nfiles:\n${files}path: ${named[0]}\nsha512: x\n`);
    }
}

function run(os: string, arch: string): { status: number | null; stdout: string; output: string } {
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const result = spawnSync('bash', [nameAssets], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, RUNNER_OS: os, RUNNER_ARCH: arch, GITHUB_OUTPUT: output },
    });
    return { status: result.status, stdout: result.stdout, output: readFileSync(output, 'utf8') };
}

/** The lines of one multi-line output the script wrote in the `name<<EOL` form. */
function outputList(output: string, name: string): string[] {
    const match = new RegExp(`^${name}<<EOL\\n([\\s\\S]*?)\\nEOL$`, 'm').exec(output);
    return match?.[1]?.split('\n') ?? [];
}

const LINUX_X64 = [
    'Kubermeister-1.2.3-linux-x86_64.AppImage',
    'Kubermeister-1.2.3-linux-amd64.deb',
    'Kubermeister-1.2.3-linux-x86_64.rpm',
];
const LINUX_ARM64 = [
    'Kubermeister-1.2.3-linux-arm64.AppImage',
    'Kubermeister-1.2.3-linux-arm64.deb',
    'Kubermeister-1.2.3-linux-aarch64.rpm',
];

describe('naming what a runner packaged', () => {
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'km-package-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('finds the x64 Linux feed and every package', () => {
        release(LINUX_X64, { 'latest-linux.yml': LINUX_X64 });
        const { status, output } = run('Linux', 'X64');
        expect(status).toBe(0);
        expect(outputList(output, 'installers').sort()).toEqual(LINUX_X64.map((name) => `release/${name}`).sort());
        expect(outputList(output, 'feeds')).toEqual(['release/latest-linux.yml']);
    });

    it('finds the arm64 Linux feed, which carries the architecture in its name', () => {
        release(LINUX_ARM64, { 'latest-linux-arm64.yml': LINUX_ARM64 });
        const { status, output } = run('Linux', 'ARM64');
        expect(status).toBe(0);
        expect(outputList(output, 'feeds')).toEqual(['release/latest-linux-arm64.yml']);
    });

    it('uploads the rpm, which is published with the other Linux packages', () => {
        release(LINUX_ARM64, { 'latest-linux-arm64.yml': LINUX_ARM64 });
        const { output } = run('Linux', 'ARM64');
        expect(outputList(output, 'installers')).toContain('release/Kubermeister-1.2.3-linux-aarch64.rpm');
    });

    it('refuses an arm64 build whose feed is not the one its updater reads', () => {
        // electron-updater on arm64 asks for latest-linux-arm64.yml and never reads latest-linux.yml.
        release(LINUX_ARM64, { 'latest-linux.yml': LINUX_ARM64 });
        const { status, stdout } = run('Linux', 'ARM64');
        expect(status).toBe(1);
        expect(stdout).toContain('latest-linux-arm64.yml');
    });

    it("refuses a Linux runner writing another architecture's feed, which would overwrite that runner's", () => {
        release([...LINUX_X64, ...LINUX_ARM64], {
            'latest-linux.yml': LINUX_X64,
            'latest-linux-arm64.yml': LINUX_ARM64,
        });
        const { status, stdout } = run('Linux', 'X64');
        expect(status).toBe(1);
        expect(stdout).toContain('latest-linux-arm64.yml belongs to another');
    });

    it('refuses an installer no feed names, since its users would never see an update', () => {
        release(LINUX_X64, { 'latest-linux.yml': [LINUX_X64[0]!] });
        const { status, stdout } = run('Linux', 'X64');
        expect(status).toBe(1);
        expect(stdout).toContain('no feed names Kubermeister-1.2.3-linux-amd64.deb');
    });

    it('refuses a feed naming a file that is not among the installers', () => {
        release([LINUX_X64[0]!], { 'latest-linux.yml': LINUX_X64 });
        const { status, stdout } = run('Linux', 'X64');
        expect(status).toBe(1);
        expect(stdout).toContain('names Kubermeister-1.2.3-linux-amd64.deb, which is not under release/');
    });

    it('refuses a build with no feed at all', () => {
        release(LINUX_X64, {});
        expect(run('Linux', 'X64').status).toBe(1);
    });

    it('uploads the macOS blockmaps with the installers and the one feed naming both architectures', () => {
        const mac = ['arm64', 'x64'].flatMap((arch) => [
            `Kubermeister-1.2.3-mac-${arch}.dmg`,
            `Kubermeister-1.2.3-mac-${arch}.zip`,
        ]);
        release([...mac, ...mac.map((name) => `${name}.blockmap`)], { 'latest-mac.yml': mac });
        const { status, output } = run('macOS', 'ARM64');
        expect(status).toBe(0);
        expect(outputList(output, 'installers')).toHaveLength(8);
        expect(outputList(output, 'feeds')).toEqual(['release/latest-mac.yml']);
    });

    it('finds the Windows feed, which carries no OS in its name', () => {
        const exe = 'Kubermeister-1.2.3-win-x64.exe';
        release([exe, `${exe}.blockmap`], { 'latest.yml': [exe] });
        const { status, output } = run('Windows', 'X64');
        expect(status).toBe(0);
        expect(outputList(output, 'feeds')).toEqual(['release/latest.yml']);
    });
});

describe('the package action', () => {
    it('installs rpmbuild on Linux before packaging, since the runner image carries none', () => {
        const install = indexOf(/rpm/i);
        expect(install).toBeGreaterThanOrEqual(0);
        expect(steps[install]?.run).toContain('apt-get install');
        expect(install).toBeLessThan(indexOf(/^package$/i));
    });

    it('uploads and verifies every feed it found rather than one it names', () => {
        for (const step of [steps[indexOf(/^upload updater/i)], steps[indexOf(/^verify the uploaded updater/i)]]) {
            expect(step?.env?.FILES).toBe('${{ steps.files.outputs.feeds }}');
        }
        expect(JSON.stringify(steps)).not.toMatch(/release\/latest[\w-]*\.yml/);
    });

    it('uploads the feeds only once the installers they name are verified, and verifies them too', () => {
        const order = [
            indexOf(/^upload installers/i),
            indexOf(/^verify the uploaded installers/i),
            indexOf(/^upload updater/i),
            indexOf(/^verify the uploaded updater/i),
        ];
        expect(order.every((index) => index >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });
});
