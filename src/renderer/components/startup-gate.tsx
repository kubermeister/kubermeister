import type { ReactNode } from 'react';
import type { StartupCheck } from '../../shared/ipc';
import { describeError } from '@/lib/k8s-error';
import { useIpcQuery } from '@/lib/query';
import { Preloader } from './preloader';
import { StartupError } from './startup-error';

/**
 * Boots the app behind the startup checks: preloader while they run, then the app. A failing check
 * does not hold the shell back: only cluster calls depend on the kubeconfig, so the sidebar, top bar,
 * Settings and updates open regardless and the top bar's connection notice carries the failure and
 * its fixes. The one screen that still blocks is a bridge that cannot answer at all, since nothing
 * behind it could work either. The result is kept forever, so a later transient failure cannot
 * unmount a running app; the notice refetches it when the user acts on it.
 */
export function StartupGate({ children }: { children: ReactNode }) {
    const { data, isPending, isError, error, isFetching, refetch } = useIpcQuery(
        'startupChecks',
        {},
        { staleTime: Infinity, gcTime: Infinity },
    );

    if (isPending) return <Preloader />;

    if (isError && !data) {
        const described = describeError(error);
        const fallback: StartupCheck[] = [
            { id: 'kubeconfig', label: 'Startup checks', status: 'error', detail: described.detail },
        ];
        return <StartupError checks={fallback} onRetry={() => void refetch()} retrying={isFetching} />;
    }

    return <>{children}</>;
}
