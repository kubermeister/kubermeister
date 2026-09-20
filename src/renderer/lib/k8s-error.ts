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
