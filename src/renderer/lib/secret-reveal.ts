import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { SecretValue } from '../../shared/k8s/workloads';
import { invoke } from './ipc';
import { describeError } from './k8s-error';

/**
 * How long a revealed value stays on screen. A value is revealed for the moment somebody is
 * reading it, not for as long as the page stays open, so it masks itself again unasked.
 */
export const REVEAL_TIMEOUT_MS = 30_000;

export interface SecretRevealState {
    /** The value on screen for this key, or undefined while it is masked. */
    shown: (key: string) => SecretValue | undefined;
    /** The key whose read is in flight, so its row can say so. */
    pending: string | null;
    toggle: (key: string) => void;
    copy: (key: string) => void;
}

/**
 * Reveal and copy one Secret key at a time. Each click asks main for that single key, so the rest
 * of the map never reaches the renderer, and the answer is held in this hook's own state rather
 * than in the query cache: nothing persists it, a copy never puts it on screen at all, and leaving
 * the page takes every revealed value with it.
 */
export function useSecretReveal(name: string, namespace: string): SecretRevealState {
    // Everything below belongs to one Secret. The screen remounts on another object, but the hook
    // does not rely on that: state recorded for another Secret reads as masked and is dropped, and a
    // read that answers after the Secret changed is discarded rather than shown under the new one.
    const secret = `${namespace}/${name}`;
    const current = useRef(secret);
    const [revealed, setRevealed] = useState<{ secret: string; values: Record<string, SecretValue> }>({
        secret,
        values: {},
    });
    const [pending, setPending] = useState<{ secret: string; key: string } | null>(null);
    const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    if (revealed.secret !== secret) setRevealed({ secret, values: {} });
    const values = revealed.secret === secret ? revealed.values : {};

    useEffect(() => {
        current.current = secret;
        const running = timers.current;
        return () => {
            running.forEach((timer) => clearTimeout(timer));
            running.clear();
        };
    }, [secret]);

    const hide = useCallback((key: string) => {
        const timer = timers.current.get(key);
        if (timer) clearTimeout(timer);
        timers.current.delete(key);
        setRevealed(({ secret: owner, values: { [key]: _hidden, ...rest } }) => ({ secret: owner, values: rest }));
    }, []);

    const read = useCallback(
        async (key: string): Promise<SecretValue | null> => {
            setPending({ secret, key });
            try {
                const value = await invoke('secrets.reveal', { name, namespace, key });
                if (current.current !== secret) return null;
                if (!value) toast.error('Key not found', { description: `“${key}” is no longer in this Secret.` });
                return value;
            } catch (error) {
                if (current.current !== secret) return null;
                const { title, detail } = describeError(error);
                toast.error(title, { description: detail });
                return null;
            } finally {
                setPending((now) => (now?.secret === secret && now.key === key ? null : now));
            }
        },
        [secret, name, namespace],
    );

    const reveal = useCallback(
        async (key: string) => {
            const value = await read(key);
            if (!value) return;
            setRevealed((now) => (now.secret === secret ? { secret, values: { ...now.values, [key]: value } } : now));
            timers.current.set(
                key,
                setTimeout(() => hide(key), REVEAL_TIMEOUT_MS),
            );
        },
        [secret, read, hide],
    );

    const copy = useCallback(
        async (key: string) => {
            const value = await read(key);
            if (!value) return;
            try {
                await navigator.clipboard.writeText(value.value);
            } catch {
                // Saying "copied" when nothing was copied is worse here than anywhere else: the
                // user would paste whatever the clipboard held before.
                toast.error('Copy failed', { description: `“${key}” could not be put on the clipboard.` });
                return;
            }
            toast.success(`“${key}” copied`, { description: 'The value went to the clipboard without being shown.' });
        },
        [read],
    );

    return {
        shown: (key) => values[key],
        pending: pending?.secret === secret ? pending.key : null,
        toggle: (key) => (values[key] ? hide(key) : void reveal(key)),
        copy: (key) => void copy(key),
    };
}
