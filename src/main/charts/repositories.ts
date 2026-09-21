import { load as loadYaml } from 'js-yaml';
import {
    MAX_CHART_REPOSITORIES,
    type ChartRepository,
    type ChartRepositoryInput,
    type ChartRepositoryStatus,
    type ChartSummary,
} from '../../shared/charts.js';
import { K8sError, toK8sError } from '../k8s/errors.js';
import { getSettings, updateSettings } from '../settings/store.js';
import { readIndex, removeIndex, writeIndex } from './cache.js';
import { getCredential, hasCredential, removeCredential, setCredential } from './credentials.js';
import { indexUrl, isChartIndexDocument, parseChartIndex, readCappedText } from './index-file.js';
import { basicAuth, httpFailure, pingRegistry, type RegistryCredential } from './registry.js';

/**
 * Configured chart sources: the list in the settings file, the credential each one has in the OS
 * keychain and the index each one last published, kept in step. Nothing here touches the cluster —
 * a chart source is a fact about this install, not about the context it happens to be on — so the
 * cluster read ceiling does not apply and each request carries its own.
 */

/** How long a repository has to serve its index before the read gives up. */
const INDEX_TIMEOUT_MS = 30_000;

/** Failures reach the renderer as the same classified envelope every other channel answers with. */
async function classified<T>(op: string, run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        throw toK8sError(op, error);
    }
}

function configured(): ChartRepository[] {
    return getSettings().charts.repositories;
}

function find(name: string, op: string): ChartRepository {
    const repository = configured().find((candidate) => candidate.name === name);
    if (!repository) throw new K8sError('notFound', `No chart repository is named "${name}".`, op);
    return repository;
}

function toStatus(repository: ChartRepository, read: { chartCount: number | null; refreshedAt: string | null }) {
    return { ...repository, hasCredentials: hasCredential(repository.name), ...read };
}

async function fetchCharts(op: string, repository: ChartRepository, credential: RegistryCredential | null) {
    const response = await fetch(indexUrl(repository.url), {
        headers: { accept: 'application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.8', ...basicAuth(credential) },
        redirect: 'follow',
        signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
    });
    if (!response.ok) throw httpFailure(op, response.status, 'The repository');
    const text = await readCappedText(op, response);
    let document: unknown;
    try {
        document = loadYaml(text);
    } catch {
        document = null;
    }
    // A repository with no charts publishes `entries: {}`; a login page served with a 200 does not,
    // and caching that as an empty repository would hide the real problem behind an empty list.
    if (!isChartIndexDocument(document)) {
        throw new K8sError('invalid', 'That address does not serve a Helm repository index.', op);
    }
    return parseChartIndex(document);
}

/**
 * Read a source and cache what it answered. A classic repository answers with its index; an OCI
 * registry publishes none, so all that can be read is that it answers and accepts the credential —
 * the same check `helm registry login` makes. The cache file is written either way, since it is
 * also what records when the source was last reached.
 */
async function readSource(
    op: string,
    repository: ChartRepository,
    credential: RegistryCredential | null,
): Promise<ChartRepositoryStatus> {
    let charts: ChartSummary[] = [];
    if (repository.kind === 'oci') await pingRegistry(op, repository.url, credential);
    else charts = await fetchCharts(op, repository, credential);
    const refreshedAt = new Date().toISOString();
    writeIndex(repository.name, { url: repository.url, refreshedAt, charts });
    return toStatus(repository, { chartCount: repository.kind === 'oci' ? null : charts.length, refreshedAt });
}

export function listChartRepositories(): Promise<ChartRepositoryStatus[]> {
    return classified('chartRepositories.list', async () =>
        configured().map((repository) => {
            const cached = readIndex(repository.name, repository.url);
            return toStatus(repository, {
                chartCount: repository.kind === 'oci' ? null : (cached?.charts.length ?? null),
                refreshedAt: cached?.refreshedAt ?? null,
            });
        }),
    );
}

/**
 * Add a source, reading it before recording it: an address that answers with no index is a typo,
 * and a list holding one would report it as broken from then on rather than at the moment it was
 * typed. Nothing is written to the settings file until the source has answered, and a credential
 * stored for an add that then failed is taken back out of the keychain.
 */
export function addChartRepository(input: ChartRepositoryInput): Promise<ChartRepositoryStatus> {
    const op = 'chartRepositories.add';
    return classified(op, async () => {
        const { username, password, ...repository } = input;
        const existing = configured();
        if (existing.some((candidate) => candidate.name === repository.name)) {
            throw new K8sError('conflict', `A chart repository named "${repository.name}" already exists.`, op);
        }
        if (existing.length >= MAX_CHART_REPOSITORIES) {
            throw new K8sError('invalid', `Kubermeister holds ${MAX_CHART_REPOSITORIES} chart repositories.`, op);
        }
        const credential = username !== undefined && password !== undefined ? { username, password } : null;
        if (credential) setCredential(repository.name, credential, op);
        try {
            const status = await readSource(op, repository, credential);
            updateSettings({ charts: { repositories: [...existing, repository] } });
            return status;
        } catch (error) {
            if (credential) removeCredential(repository.name, op);
            throw error;
        }
    });
}

/** Read a configured source again. A failed refresh leaves the last good index in place. */
export function refreshChartRepository(name: string): Promise<ChartRepositoryStatus> {
    const op = 'chartRepositories.refresh';
    return classified(op, async () => {
        const repository = find(name, op);
        return readSource(op, repository, getCredential(name));
    });
}

/** Forget a source: its entry, its cached index and its credential all go together. */
export function removeChartRepository(name: string): Promise<{ name: string }> {
    const op = 'chartRepositories.remove';
    return classified(op, async () => {
        find(name, op);
        updateSettings({ charts: { repositories: configured().filter((candidate) => candidate.name !== name) } });
        removeIndex(name);
        removeCredential(name, op);
        return { name };
    });
}
