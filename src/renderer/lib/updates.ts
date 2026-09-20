import { useCallback, useEffect, useState } from 'react';
import type { UpdateState } from '../../shared/ipc';
import { invoke, subscribe } from './ipc';

/**
 * The updater's state as the main process pushes it, plus a check the user can start. The state
 * lives in main, so every window and every screen sees the same thing; this hook only mirrors it.
 */
export function useUpdater(): { state: UpdateState | null; check: () => Promise<void> } {
    const [state, setState] = useState<UpdateState | null>(null);

    useEffect(() => {
        // A push can arrive before the initial read resolves; the push is newer, so it wins.
        let active = true;
        let pushed = false;
        const unsubscribe = subscribe('update.state', (next) => {
            pushed = true;
            if (active) setState(next);
        });
        void invoke('update.state', {}).then((next) => {
            if (active && !pushed && next) setState(next);
        });
        return () => {
            active = false;
            unsubscribe();
        };
    }, []);

    // The settled state comes back directly as well as over the push channel, so a screen that
    // asked for the check shows the outcome even if the push was missed.
    const check = useCallback(async () => {
        const settled = await invoke('update.check', {});
        setState(settled);
    }, []);

    return { state, check };
}

export const downloadUpdate = () => invoke('update.download', {});
export const installUpdate = () => invoke('update.install', {});

export type UpdateTone = 'accent' | 'neutral' | 'danger';

/** The pill in the top bar: only states that ask something of the user, or null to stay hidden. */
export function pillLabel(state: UpdateState | null): { label: string; tone: UpdateTone } | null {
    if (!state) return null;
    switch (state.status) {
        case 'available':
            return { label: 'Update available', tone: 'accent' };
        case 'downloading':
            return { label: `Downloading ${state.percent ?? 0}%`, tone: 'neutral' };
        case 'downloaded':
            return { label: 'Restart to update', tone: 'accent' };
        case 'error':
            // A scheduled check that failed is recorded in Settings, not waved at the user.
            return state.background ? null : { label: 'Update failed', tone: 'danger' };
        default:
            return null;
    }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "just now", "5 min ago", "3 h ago", then the calendar date. */
export function formatRelative(iso: string, now: number = Date.now()): string {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return iso;
    const elapsed = Math.max(0, now - then);
    if (elapsed < MINUTE) return 'just now';
    if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
    if (elapsed < 24 * HOUR) return `${Math.floor(elapsed / HOUR)} h ago`;
    return new Date(then).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function releasedOn(state: UpdateState): string | undefined {
    if (!state.releaseDate) return undefined;
    const date = Date.parse(state.releaseDate);
    if (Number.isNaN(date)) return undefined;
    return `Released ${new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}.`;
}

/** One line for the popover and the Settings card, with an optional second line of detail. */
export function describeUpdate(
    state: UpdateState | null,
    now: number = Date.now(),
): { title: string; detail?: string } {
    if (!state) return { title: 'Loading update status…' };
    switch (state.status) {
        case 'unsupported':
            return { title: 'In-app updates are unavailable here.', detail: state.message };
        case 'idle':
            return { title: 'Not checked yet.' };
        case 'checking':
            return { title: 'Checking for updates…' };
        case 'up-to-date':
            return {
                title: "You're on the latest version.",
                detail: state.checkedAt ? `Checked ${formatRelative(state.checkedAt, now)}.` : undefined,
            };
        case 'available':
            // Not the release notes: a generated changelog is a list of pull requests, and the
            // "What's new" link beside this is where it reads properly.
            return { title: `Version ${state.version ?? '?'} is available.`, detail: releasedOn(state) };
        case 'downloading':
            return { title: `Downloading version ${state.version ?? '?'}… ${state.percent ?? 0}%` };
        case 'downloaded':
            return {
                title: `Version ${state.version ?? '?'} is ready to install.`,
                detail: 'Restart to finish the update; it also installs the next time the app quits.',
            };
        case 'error':
            return { title: 'Update check failed.', detail: state.message };
    }
}

/** A check started from somewhere without a view of the state (menu, palette); the push carries the outcome. */
export const checkForUpdates = () => invoke('update.check', {});
