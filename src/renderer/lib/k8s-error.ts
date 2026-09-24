import type { K8sErrorKind } from '../../shared/k8s/errors';
import { IpcError } from './ipc';

export interface DescribedError {
    kind: K8sErrorKind;
    title: string;
    detail: string;
}

const TITLES: Record<K8sErrorKind, string> = {
    kubeconfig: 'Kubeconfig not loaded',
    unreachable: 'Cluster unreachable',
    timeout: 'Cluster timed out',
    forbidden: 'Access denied',
    unauthorized: 'Not authenticated',
    notFound: 'Not found',
    conflict: 'Conflict',
    invalid: 'Invalid manifest',
    unknown: 'Something went wrong',
};

/** Title and detail for any failure: structured for an {@link IpcError}, best effort otherwise. */
export function describeError(error: unknown): DescribedError {
    if (error instanceof IpcError) {
        return { kind: error.kind, title: TITLES[error.kind], detail: error.detail || TITLES[error.kind] };
    }
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    return { kind: 'unknown', title: TITLES.unknown, detail: message || TITLES.unknown };
}

/**
 * What was being read when a read failed: a list names its kind in the plural ("Pods"), a detail
 * one object of a kind ("Pod", read as "this Pod").
 */
export type ReadSubject = { plural: string } | { one: string };

/**
 * The sentence under a failed read's title, shared by list and detail screens so both say the same
 * thing in the same words.
 */
export function readErrorSentence(kind: K8sErrorKind, subject: ReadSubject): string {
    const noun = 'plural' in subject ? subject.plural : `this ${subject.one}`;
    switch (kind) {
        case 'kubeconfig':
            return 'The kubeconfig could not be loaded, so no cluster can be asked.';
        case 'forbidden':
            return `You don't have permission to view ${noun}.`;
        case 'unauthorized':
            return `Your session isn't authenticated to the cluster.`;
        case 'unreachable':
            return 'The cluster API server is unreachable.';
        case 'timeout':
            return `The cluster took too long to return ${noun}.`;
        case 'notFound':
            return 'plural' in subject
                ? `${subject.plural} aren't available on this cluster.`
                : `This ${subject.one} isn't on this cluster.`;
        default:
            return `Failed to load ${'plural' in subject ? subject.plural : subject.one}.`;
    }
}
