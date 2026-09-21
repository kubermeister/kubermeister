import { z } from 'zod';

/**
 * Where charts come from. Helm has no API in the cluster and none outside it either: a classic
 * repository is a web server publishing an `index.yaml` that lists every chart it holds, and an OCI
 * registry publishes no index at all — a chart there is addressed by its own name, the way
 * `helm pull oci://…` addresses one. The two are configured side by side and probed differently.
 */

export const CHART_REPOSITORY_KINDS = ['classic', 'oci'] as const;
export const chartRepositoryKindSchema = z.enum(CHART_REPOSITORY_KINDS);

/**
 * A repository name is the short handle the user types, as `helm repo add` takes one. It is also
 * the name of the file its index is cached under, so it is held to characters that cannot leave
 * that directory.
 */
export const CHART_REPOSITORY_NAME = /^[a-z0-9]([-a-z0-9_.]{0,61}[a-z0-9])?$/;
export const chartRepositoryNameSchema = z
    .string()
    .regex(CHART_REPOSITORY_NAME, 'must be lowercase letters, digits, dashes, dots or underscores');

/** How many sources the settings file will hold; past this the list stops being a list. */
export const MAX_CHART_REPOSITORIES = 50;

export const chartRepositorySchema = z.object({
    name: chartRepositoryNameSchema,
    kind: chartRepositoryKindSchema,
    url: z.string().min(1).max(2048),
});

/** What is wrong with this URL for this kind of source, or null when nothing is. */
export function chartRepositoryUrlProblem(kind: ChartRepositoryKind, url: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return 'Enter a full URL, including the scheme.';
    }
    if (!parsed.hostname) return 'The URL names no host.';
    if (kind === 'oci') return parsed.protocol === 'oci:' ? null : 'An OCI registry is addressed as oci://host.';
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? null
        : 'A chart repository is served over http:// or https://.';
}

/**
 * Whether a credential sent to this URL would cross the network readable. A repository reachable
 * only over plaintext http is still usable anonymously; what it may not have is a password.
 */
export function sendsCredentialsInClear(url: string): boolean {
    try {
        return new URL(url).protocol === 'http:';
    } catch {
        return false;
    }
}

export const chartRepositoryInputSchema = chartRepositorySchema
    .extend({
        /** A username and its password, kept in the OS keychain and never written to the settings file. */
        username: z.string().min(1).max(256).optional(),
        password: z.string().min(1).max(4096).optional(),
    })
    .superRefine((input, ctx) => {
        const problem = chartRepositoryUrlProblem(input.kind, input.url);
        if (problem) ctx.addIssue({ code: 'custom', path: ['url'], message: problem });
        if ((input.username === undefined) !== (input.password === undefined)) {
            ctx.addIssue({ code: 'custom', path: ['password'], message: 'Give a username and a password together.' });
        }
        if (input.password !== undefined && sendsCredentialsInClear(input.url)) {
            ctx.addIssue({ code: 'custom', path: ['url'], message: 'A password needs an https URL.' });
        }
    });

export const chartRepositoryStatusSchema = chartRepositorySchema.extend({
    /** Whether a credential for this source is held in the OS keychain; the password itself never travels. */
    hasCredentials: z.boolean(),
    /** Charts the cached index holds; null for an OCI registry, which publishes no index. */
    chartCount: z.number().int().nonnegative().nullable(),
    /** When the source was last read, ISO 8601; null until the first refresh lands. */
    refreshedAt: z.string().nullable(),
});

/** One chart as its repository's index describes it, versions newest first. */
export const chartSummarySchema = z.object({
    name: z.string(),
    latestVersion: z.string(),
    appVersion: z.string(),
    description: z.string(),
    versions: z.array(z.string()).min(1),
});

/**
 * A repository's index as it is cached on disk. The URL it came from is kept with it, so a cache
 * file left behind by a repository that has since been re-pointed is not read as the new one's.
 */
export const chartIndexSchema = z.object({
    url: z.string(),
    refreshedAt: z.string(),
    charts: z.array(chartSummarySchema),
});

export const chartRepositoryNameInputSchema = z.object({ name: chartRepositoryNameSchema });

export type ChartRepositoryKind = (typeof CHART_REPOSITORY_KINDS)[number];
export type ChartRepository = z.infer<typeof chartRepositorySchema>;
export type ChartRepositoryInput = z.infer<typeof chartRepositoryInputSchema>;
export type ChartRepositoryStatus = z.infer<typeof chartRepositoryStatusSchema>;
export type ChartSummary = z.infer<typeof chartSummarySchema>;
export type ChartIndex = z.infer<typeof chartIndexSchema>;
