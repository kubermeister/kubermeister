import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { K8sError } from '../k8s/errors.js';
import type { RegistryCredential } from './registry.js';

/**
 * Chart repository credentials, kept out of the settings file. Electron's `safeStorage` seals them
 * with a key the OS holds — the Keychain on macOS, libsecret on Linux, DPAPI on Windows — so what
 * lands on disk beside the settings is ciphertext this machine's user alone can open.
 *
 * The file is a plain map from repository name to the sealed credential, which keeps it readable
 * enough to delete by hand and makes forgetting one repository's credential a single-key change.
 */

type SealedCredentials = Record<string, string>;

function credentialsPath(): string {
    return join(app.getPath('userData'), 'chart-credentials.json');
}

function load(): SealedCredentials {
    try {
        const parsed: unknown = JSON.parse(readFileSync(credentialsPath(), 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        return Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
        );
    } catch {
        // Missing (nothing stored yet), unreadable, or not JSON: nothing is held.
        return {};
    }
}

function persist(sealed: SealedCredentials, op: string): void {
    const dir = app.getPath('userData');
    const path = credentialsPath();
    try {
        mkdirSync(dir, { recursive: true });
        if (Object.keys(sealed).length === 0) {
            rmSync(path, { force: true });
            return;
        }
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(sealed, null, 4), { encoding: 'utf8', mode: 0o600 });
        renameSync(tmp, path);
    } catch (error) {
        // Unlike the settings file, a failure here is reported: a password the user typed and
        // believes is stored must never be silently dropped.
        throw new K8sError('unknown', `The credential could not be stored: ${String(error)}`, op);
    }
}

/** Whether a credential is held for this repository, without opening it. */
export function hasCredential(name: string): boolean {
    return name in load();
}

export function setCredential(name: string, credential: RegistryCredential, op = 'chartRepositories.add'): void {
    if (!safeStorage.isEncryptionAvailable()) {
        throw new K8sError(
            'invalid',
            'This system offers no secret store, so the password cannot be kept out of the settings file. Use the repository without a credential.',
            op,
        );
    }
    const sealed = safeStorage.encryptString(JSON.stringify(credential)).toString('base64');
    persist({ ...load(), [name]: sealed }, op);
}

export function removeCredential(name: string, op = 'chartRepositories.remove'): void {
    const sealed = load();
    if (!(name in sealed)) return;
    delete sealed[name];
    persist(sealed, op);
}

/**
 * The credential for this repository, or null when there is none — including when there is one this
 * machine's key can no longer open, which is what a file copied from another machine leaves behind.
 */
export function getCredential(name: string): RegistryCredential | null {
    const sealed = load()[name];
    if (!sealed) return null;
    try {
        const parsed: unknown = JSON.parse(safeStorage.decryptString(Buffer.from(sealed, 'base64')));
        const { username, password } = (parsed ?? {}) as { username?: unknown; password?: unknown };
        if (typeof username !== 'string' || typeof password !== 'string') return null;
        return { username, password };
    } catch (error) {
        console.error(`[charts] the stored credential for "${name}" could not be opened`, error);
        return null;
    }
}
