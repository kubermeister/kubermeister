import { REPOSITORY_URL } from './updates.js';

/**
 * The bug report form asks for the app version and the operating system, which the app already
 * knows about itself. A GitHub issue form takes its own field ids as query parameters, so the link
 * can arrive filled in and the reporter is left describing what happened.
 */

/** What the report link fills in, which is exactly what `app.info` answers. */
export interface BugReportInfo {
    version: string;
    platform: string;
    arch: string;
    electron: string;
    chrome: string;
    node: string;
}

/**
 * The `os` dropdown's own options, matched verbatim: a value the form does not offer selects
 * nothing. Linux is deliberately absent — the form separates AppImage from deb, and an app cannot
 * tell which installer put it there, so the reporter picks.
 */
function osOption({ platform, arch }: BugReportInfo): string | undefined {
    if (platform === 'darwin') return arch === 'arm64' ? 'macOS (Apple silicon)' : 'macOS (Intel)';
    if (platform === 'win32') return 'Windows';
    return undefined;
}

/** A prefilled bug report on the repository's issue form. */
export function bugReportUrl(info: BugReportInfo): string {
    const params = new URLSearchParams({ template: 'bug_report.yml', version: info.version });
    const os = osOption(info);
    if (os) params.set('os', os);
    // The form renders this field as plain text, so the versions go in as the first line and the
    // reporter's own account of what the app said follows underneath.
    params.set('logs', `Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node}\n`);
    return `${REPOSITORY_URL}/issues/new?${params.toString()}`;
}
