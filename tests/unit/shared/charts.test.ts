import { describe, expect, it } from 'vitest';
import {
    chartRepositoryInputSchema,
    chartRepositoryStatusSchema,
    chartRepositoryUrlProblem,
    sendsCredentialsInClear,
} from '../../../src/shared/charts';

const classic = { name: 'bitnami', kind: 'classic', url: 'https://charts.bitnami.com/bitnami' };
const oci = { name: 'ghcr', kind: 'oci', url: 'oci://ghcr.io/example' };

describe('chartRepositoryUrlProblem', () => {
    it('accepts the scheme each kind of source is published under', () => {
        expect(chartRepositoryUrlProblem('classic', 'https://charts.example.com')).toBeNull();
        expect(chartRepositoryUrlProblem('classic', 'http://localhost:8879/charts')).toBeNull();
        expect(chartRepositoryUrlProblem('oci', 'oci://registry-1.docker.io/bitnamicharts')).toBeNull();
        expect(chartRepositoryUrlProblem('oci', 'oci://reg.example.com:5000')).toBeNull();
    });

    it('refuses the other kind of URL, so a source is never probed the wrong way', () => {
        expect(chartRepositoryUrlProblem('classic', 'oci://ghcr.io/example')).toBeTruthy();
        expect(chartRepositoryUrlProblem('oci', 'https://charts.example.com')).toBeTruthy();
    });

    it('refuses anything that is not a URL naming a host', () => {
        for (const url of ['', 'charts.example.com', 'not a url', 'file:///etc/passwd', 'https://']) {
            expect(chartRepositoryUrlProblem('classic', url), url).toBeTruthy();
        }
    });
});

describe('sendsCredentialsInClear', () => {
    it('is true only for plaintext http, where a password would cross the network readable', () => {
        expect(sendsCredentialsInClear('http://charts.example.com')).toBe(true);
        expect(sendsCredentialsInClear('https://charts.example.com')).toBe(false);
        expect(sendsCredentialsInClear('oci://ghcr.io/example')).toBe(false);
        // Unparseable is refused by the URL check already; it is not reported as plaintext too.
        expect(sendsCredentialsInClear('nonsense')).toBe(false);
    });
});

describe('chartRepositoryInputSchema', () => {
    it('accepts a classic repository and an OCI registry', () => {
        expect(chartRepositoryInputSchema.safeParse(classic).success).toBe(true);
        expect(chartRepositoryInputSchema.safeParse(oci).success).toBe(true);
    });

    it('takes a credential as a username and a password together, never one alone', () => {
        expect(chartRepositoryInputSchema.safeParse({ ...classic, username: 'u', password: 'p' }).success).toBe(true);
        expect(chartRepositoryInputSchema.safeParse({ ...classic, username: 'u' }).success).toBe(false);
        expect(chartRepositoryInputSchema.safeParse({ ...classic, password: 'p' }).success).toBe(false);
        expect(chartRepositoryInputSchema.safeParse({ ...classic, username: '', password: 'p' }).success).toBe(false);
    });

    it('refuses a credential bound for a plaintext http URL', () => {
        const url = 'http://charts.example.com';
        expect(chartRepositoryInputSchema.safeParse({ ...classic, url }).success).toBe(true);
        expect(chartRepositoryInputSchema.safeParse({ ...classic, url, username: 'u', password: 'p' }).success).toBe(
            false,
        );
    });

    it('holds the name to a short handle, so it can be a file name in the index cache', () => {
        for (const name of ['bitnami', 'my-charts', 'team.internal', 'a_b', 'x1']) {
            expect(chartRepositoryInputSchema.safeParse({ ...classic, name }).success, name).toBe(true);
        }
        for (const name of ['', '../escape', 'UPPER', 'has space', '-leading', 'trailing-', 'a/b', '.']) {
            expect(chartRepositoryInputSchema.safeParse({ ...classic, name }).success, name).toBe(false);
        }
    });

    it('refuses an unknown kind and a URL the kind does not publish under', () => {
        expect(chartRepositoryInputSchema.safeParse({ ...classic, kind: 'git' }).success).toBe(false);
        expect(chartRepositoryInputSchema.safeParse({ ...classic, url: 'oci://ghcr.io/x' }).success).toBe(false);
    });
});

describe('chartRepositoryStatusSchema', () => {
    it('reports a count and a refresh time that are both unknown until a refresh lands', () => {
        const fresh = { ...classic, hasCredentials: false, chartCount: null, refreshedAt: null };
        expect(chartRepositoryStatusSchema.safeParse(fresh).success).toBe(true);
        expect(
            chartRepositoryStatusSchema.safeParse({
                ...fresh,
                chartCount: 42,
                refreshedAt: '2026-09-22T10:00:00.000Z',
            }).success,
        ).toBe(true);
        // The password never crosses the bridge back: only whether one is held.
        expect(chartRepositoryStatusSchema.parse({ ...fresh, password: 'p' })).not.toHaveProperty('password');
        expect(chartRepositoryStatusSchema.safeParse({ ...fresh, chartCount: -1 }).success).toBe(false);
    });
});
