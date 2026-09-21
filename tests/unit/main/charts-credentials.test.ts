import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userData = '';
const safeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    // Stands in for the OS key: readable here, but never the plaintext the file would hold.
    encryptString: vi.fn((plain: string) => Buffer.from(`sealed:${plain}`, 'utf8')),
    decryptString: vi.fn((sealed: Buffer) => {
        const text = sealed.toString('utf8');
        if (!text.startsWith('sealed:')) throw new Error('decryption failed');
        return text.slice('sealed:'.length);
    }),
};
vi.mock('electron', () => ({ app: { getPath: () => userData }, safeStorage }));

async function loadCredentials() {
    vi.resetModules();
    return import('../../../src/main/charts/credentials.js');
}

const file = () => join(userData, 'chart-credentials.json');

describe('chart repository credentials', () => {
    beforeEach(() => {
        userData = mkdtempSync(join(tmpdir(), 'km-charts-cred-'));
        vi.clearAllMocks();
        safeStorage.isEncryptionAvailable.mockReturnValue(true);
    });

    afterEach(() => {
        rmSync(userData, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('keeps a credential sealed by the OS key, never as plaintext on disk', async () => {
        const { setCredential, getCredential, hasCredential } = await loadCredentials();
        setCredential('bitnami', { username: 'ara', password: 'hunter2' });
        expect(safeStorage.encryptString).toHaveBeenCalledOnce();
        const raw = readFileSync(file(), 'utf8');
        expect(raw).not.toContain('hunter2');
        expect(raw).not.toContain('ara');
        expect(getCredential('bitnami')).toEqual({ username: 'ara', password: 'hunter2' });
        expect(hasCredential('bitnami')).toBe(true);
        expect(hasCredential('other')).toBe(false);
        expect(getCredential('other')).toBeNull();
    });

    it('refuses to store anything when the system has no secret store, rather than writing it in the clear', async () => {
        safeStorage.isEncryptionAvailable.mockReturnValue(false);
        const { setCredential, hasCredential } = await loadCredentials();
        expect(() => setCredential('bitnami', { username: 'ara', password: 'hunter2' })).toThrow(/secret store/);
        expect(existsSync(file())).toBe(false);
        expect(hasCredential('bitnami')).toBe(false);
    });

    it('forgets a credential, leaving the others in place', async () => {
        const { setCredential, removeCredential, hasCredential } = await loadCredentials();
        setCredential('a', { username: 'u', password: 'p' });
        setCredential('b', { username: 'u', password: 'p' });
        removeCredential('a');
        expect(hasCredential('a')).toBe(false);
        expect(hasCredential('b')).toBe(true);
        // Removing one that was never stored is not an error; a repository may simply have none.
        expect(() => removeCredential('a')).not.toThrow();
        // The last one takes the file with it, rather than leaving an empty map behind.
        removeCredential('b');
        expect(existsSync(file())).toBe(false);
    });

    it('reports no credential when the file is unreadable rather than failing every read', async () => {
        writeFileSync(file(), '{ not json');
        const { getCredential, hasCredential } = await loadCredentials();
        expect(hasCredential('bitnami')).toBe(false);
        expect(getCredential('bitnami')).toBeNull();
    });

    it('reports no credential when the OS key can no longer open it', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        writeFileSync(file(), JSON.stringify({ bitnami: Buffer.from('from another machine').toString('base64') }));
        const { getCredential, hasCredential } = await loadCredentials();
        // The entry is there, so the repository still knows it was given one.
        expect(hasCredential('bitnami')).toBe(true);
        expect(getCredential('bitnami')).toBeNull();
        expect(logged).toHaveBeenCalledOnce();
    });

    it('reports a write failure instead of pretending the credential was kept', async () => {
        // A file where the directory should be makes mkdir fail.
        rmSync(userData, { recursive: true, force: true });
        writeFileSync(userData, 'not a directory');
        const { setCredential } = await loadCredentials();
        // Unlike the settings file, which is tolerated so reads keep working, a password the user
        // typed and believes is stored must never be silently dropped.
        expect(() => setCredential('bitnami', { username: 'u', password: 'p' })).toThrow(/could not be stored/);
    });
});
