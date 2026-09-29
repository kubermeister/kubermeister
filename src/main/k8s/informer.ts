import { ListWatch, Watch, type KubeConfig, type KubernetesObject, type ListPromise } from '@kubernetes/client-node';

/**
 * The client's `Watch` authenticates each request before its own try, so a credential plugin or
 * token refresh that fails makes `watch()` reject instead of calling `done`. The informer's
 * reconnect calls it from a `done` nobody awaits, so that rejection went unhandled and no `error`
 * event fired: the watch stopped and every screen on it kept showing its last rows as live.
 * Handing the failure to `done` makes it the informer's ordinary `error`.
 */
export class ReportingWatch extends Watch {
    override async watch(
        path: string,
        queryParams: Record<string, string | number | boolean | undefined>,
        callback: (phase: string, apiObj: unknown, watchObj?: unknown) => void,
        done: (err: unknown) => void,
    ): Promise<AbortController> {
        try {
            return await super.watch(path, queryParams, callback, done);
        } catch (error) {
            done(error);
            return new AbortController();
        }
    }
}

/** `makeInformer` from the client library, over a watch that reports a failed authentication. */
export function makeInformer<T extends KubernetesObject>(
    kubeConfig: KubeConfig,
    path: string,
    list: ListPromise<T>,
): ListWatch<T> {
    return new ListWatch<T>(path, new ReportingWatch(kubeConfig), list, false);
}
