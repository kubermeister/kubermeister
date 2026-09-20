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
    const [revealed, setRevealed] = useState<Record<string, SecretValue>>({});
    const [pending, setPending] = useState<string | null>(null);
    const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

    useEffect(() => {
        const running = timers.current;
        return () => running.forEach((timer) => clearTimeout(timer));
    }, []);

    const hide = useCallback((key: string) => {
        const timer = timers.current.get(key);
        if (timer) clearTimeout(timer);
        timers.current.delete(key);
        setRevealed(({ [key]: _hidden, ...rest }) => rest);
    }, []);

    const read = useCallback(
        async (key: string): Promise<SecretValue | null> => {
            setPending(key);
            try {
                const value = await invoke('secrets.reveal', { name, namespace, key });
                if (!value) toast.error('Key not found', { description: `“${key}” is no longer in this Secret.` });
                return value;
            } catch (error) {
                const { title, detail } = describeError(error);
                toast.error(title, { description: detail });
                return null;
            } finally {
                setPending(null);
            }
        },
        [name, namespace],
    );

    const reveal = useCallback(
        async (key: string) => {
            const value = await read(key);
            if (!value) return;
            setRevealed((current) => ({ ...current, [key]: value }));
            timers.current.set(
                key,
                setTimeout(() => hide(key), REVEAL_TIMEOUT_MS),
            );
        },
        [read, hide],
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
        shown: (key) => revealed[key],
        pending,
        toggle: (key) => (revealed[key] ? hide(key) : void reveal(key)),
        copy: (key) => void copy(key),
    };
}
