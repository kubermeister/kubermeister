import { describe, expect, it } from 'vitest';
import { bugReportUrl } from '../../../src/shared/bug-report.js';

const info = {
    version: '0.4.9',
    platform: 'darwin',
    arch: 'arm64',
    electron: '42.0.0',
    chrome: '140.0.0',
    node: '24.0.0',
};

const paramsOf = (url: string) => new URL(url).searchParams;

describe('bug report link', () => {
    it('opens the repository issue form with the version filled in', () => {
        const url = bugReportUrl(info);
        expect(url.startsWith('https://github.com/kubermeister/kubermeister/issues/new?')).toBe(true);
        expect(paramsOf(url).get('template')).toBe('bug_report.yml');
        expect(paramsOf(url).get('version')).toBe('0.4.9');
    });

    it('picks the operating system option the form actually offers', () => {
        expect(paramsOf(bugReportUrl(info)).get('os')).toBe('macOS (Apple silicon)');
        expect(paramsOf(bugReportUrl({ ...info, arch: 'x64' })).get('os')).toBe('macOS (Intel)');
        expect(paramsOf(bugReportUrl({ ...info, platform: 'win32' })).get('os')).toBe('Windows');
    });

    it('leaves the operating system for the reporter where the app cannot tell which it is', () => {
        // The form separates AppImage from deb, and a running app knows neither.
        expect(paramsOf(bugReportUrl({ ...info, platform: 'linux' })).get('os')).toBeNull();
        expect(paramsOf(bugReportUrl({ ...info, platform: 'freebsd' })).get('os')).toBeNull();
    });

    it('carries the runtime versions into the field the form renders as text', () => {
        expect(paramsOf(bugReportUrl(info)).get('logs')).toBe('Electron 42.0.0 · Chrome 140.0.0 · Node 24.0.0\n');
    });
});
