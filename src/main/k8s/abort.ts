import { AsyncLocalStorage } from 'node:async_hooks';
import { Observable, type Configuration, type ObservableMiddleware } from '@kubernetes/client-node';

/**
 * Which cluster call is running here, so the ceiling that gives up on it can also stop it.
 *
 * `withK8s` races a call against a timer; on its own that only stops the app waiting. The request
 * is still in flight and the credential plugin it spawned is still running, so a screen that polls
 * starts another of each on every retry. The signal is carried in an async store rather than passed
 * through the three hundred call sites that would otherwise have to forward it, and it reaches the
 * two places that can act on it: {@link abortMiddleware}, which puts it on every request the client
 * library builds, and the spawn guard in `exec-auth.ts`, which kills the plugin process with it.
 *
 * A call made outside any ceiling finds no signal and is left alone, which is what keeps the drain's
 * eviction loop — deliberately outside `withK8s` — and the watches and streams running.
 */
interface CallScope {
    /** Cleared when the call ends, so anything it left behind is not aborted along with it. */
    signal?: AbortSignal;
}

const calls = new AsyncLocalStorage<CallScope>();

/**
 * Run a cluster call with its signal in scope. The scope closes when the call settles: a timer or a
 * stream the call happened to start inherits this async context, and an aborted signal left in it
 * would go on cancelling work that has nothing to do with the call any more.
 */
export async function withAbortScope<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const scope: CallScope = { signal };
    try {
        return await calls.run(scope, fn);
    } finally {
        scope.signal = undefined;
    }
}

/** The signal of the call running here, or undefined outside one. */
export function currentAbortSignal(): AbortSignal | undefined {
    return calls.getStore()?.signal;
}

/**
 * Puts the current call's signal on every request. `RequestContext` is the one place the client
 * library takes one: its fetch passes `getSignal()` straight through to undici.
 */
export const abortMiddleware: ObservableMiddleware = {
    pre: (request) => {
        const signal = currentAbortSignal();
        if (signal) request.setSignal(signal);
        return new Observable(Promise.resolve(request));
    },
    post: (response) => new Observable(Promise.resolve(response)),
};

/** The library's configuration with {@link abortMiddleware} added to whatever it already carries. */
export function withAbortMiddleware(configuration: Configuration): Configuration {
    return { ...configuration, middleware: [...configuration.middleware, abortMiddleware] };
}

type ApiConstructor<T> = new (configuration: Configuration) => T;

/**
 * An API class whose clients carry the abort middleware. `makeApiClient` builds the configuration
 * itself and hands it to the constructor, so the constructor is where it can still be widened.
 */
export function abortable<T>(ctor: ApiConstructor<T>): ApiConstructor<T> {
    return class extends (ctor as ApiConstructor<object>) {
        constructor(configuration: Configuration) {
            super(withAbortMiddleware(configuration));
        }
    } as ApiConstructor<T>;
}
