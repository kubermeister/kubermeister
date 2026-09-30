import { Link } from '@tanstack/react-router';
import type { K8sErrorKind } from '../../../shared/k8s/errors';

interface ReadErrorHintsProps {
    kind: K8sErrorKind;
    /** Plural noun of what was being read, for the sentence about scope. */
    noun: string;
    /**
     * Whether selecting one namespace would make this read smaller: true only for a namespaced
     * list shown under "All namespaces". Cluster-wide reads (the summary, cluster-scoped kinds)
     * leave it false so they never give advice that changes nothing.
     */
    narrowable?: boolean;
}

/**
 * What a user can do about a failed cluster read, beyond retrying. Only a timeout has an answer:
 * under "All namespaces" a list is the whole cluster's, and one namespace is a fraction of it; and
 * the ceiling itself is a setting, because how long a cluster may take is a fact about that cluster.
 * Denied and unreachable reads are not helped by either, so they get no hint.
 */
export function ReadErrorHints({ kind, noun, narrowable = false }: ReadErrorHintsProps) {
    if (kind !== 'timeout') return null;
    return (
        <>
            {narrowable && (
                <span className="mt-1 max-w-xl text-meta text-text-2" data-testid="all-namespaces-hint">
                    You are viewing all namespaces, so the cluster is asked for {noun} from every one of them at once.
                    Selecting a namespace in the top bar asks for far less.
                </span>
            )}
            <span className="max-w-xl text-meta text-text-2" data-testid="read-timeout-hint">
                Large clusters need longer: you can raise the read timeout in{' '}
                <Link
                    to="/settings/{-$section}"
                    params={{ section: 'data' }}
                    className="underline underline-offset-2 hover:text-foreground"
                >
                    Settings
                </Link>
                .
            </span>
        </>
    );
}
