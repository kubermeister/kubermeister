import { act, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogLine } from '../../../src/shared/k8s/logs';
import { LogViewer, SINCE_OPTIONS } from '@/components/data-display/log-viewer';
import { NO_SEARCH } from '@/lib/log-filter';
import {
    DEFAULT_LOG_VIEW_OPTIONS,
    logViewOptions,
    readLogViewOptions,
    resetLogViewOptions,
    setLogViewOptions,
    useLogViewOptions,
} from '@/lib/log-view-options';
import { renderWithQuery } from './helpers';

const KEY = 'km-log-view';

beforeEach(() => {
    localStorage.clear();
    // The options are one store outside React, so a test starts by forgetting the copy in memory.
    resetLogViewOptions();
});
afterEach(() => vi.restoreAllMocks());

describe('log view options', () => {
    it('starts from the defaults when nothing was ever chosen', () => {
        expect(readLogViewOptions()).toEqual(DEFAULT_LOG_VIEW_OPTIONS);
    });

    it('round-trips a choice', () => {
        setLogViewOptions({ wrap: true, timestamps: false, tail: 1000 });
        resetLogViewOptions();
        expect(readLogViewOptions()).toEqual({ wrap: true, timestamps: false, tail: 1000 });
    });

    it('leaves timestamps and the tail to the screen until somebody says otherwise', () => {
        expect(readLogViewOptions().timestamps).toBeNull();
        expect(readLogViewOptions().tail).toBeNull();
    });

    it('refuses a stored tail it no longer offers, rather than leaving the picker empty', () => {
        localStorage.setItem(KEY, JSON.stringify({ wrap: false, timestamps: null, tail: 7 }));
        expect(readLogViewOptions().tail).toBeNull();
        localStorage.setItem(KEY, JSON.stringify({ wrap: false, timestamps: null, tail: 10000 }));
        expect(readLogViewOptions().tail).toBe(10000);
    });

    it('serves every reader the one answer', () => {
        const { result } = renderHook(() => useLogViewOptions());
        act(() => setLogViewOptions({ tail: 1000 }));
        // The hook and a reader that is not a component see the same change.
        expect(result.current[0].tail).toBe(1000);
        expect(logViewOptions().tail).toBe(1000);
    });

    it('falls back to the defaults for anything it cannot read', () => {
        for (const raw of ['not json', 'null', '[]', '"wrap"', '{"wrap":"yes","timestamps":1,"tail":"500"}']) {
            localStorage.setItem(KEY, raw);
            // Each option is read on its own, so a stored value of the wrong shape costs the rest
            // nothing rather than throwing the whole preference away.
            expect(readLogViewOptions()).toEqual(DEFAULT_LOG_VIEW_OPTIONS);
        }
    });

    it('survives storage that throws, as a private window does', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('denied');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('denied');
        });
        expect(readLogViewOptions()).toEqual(DEFAULT_LOG_VIEW_OPTIONS);
        expect(() => setLogViewOptions({ wrap: true })).not.toThrow();
    });

    it('writes each change back as it is made', () => {
        const { result } = renderHook(() => useLogViewOptions());
        expect(result.current[0].wrap).toBe(false);
        act(() => result.current[1]({ wrap: true }));
        expect(result.current[0].wrap).toBe(true);
        resetLogViewOptions();
        expect(readLogViewOptions().wrap).toBe(true);
    });
});

describe('the console’s View menu', () => {
    const line = (message: string): LogLine => ({ level: 'INFO', timestamp: '2026-09-21T10:00:00Z', message });
    const props = {
        lines: [line('a very long line that would otherwise run off the side of the console')],
        containers: ['web'],
        container: 'web',
        onContainerChange: () => {},
        since: SINCE_OPTIONS[0]!,
        onSinceChange: () => {},
        live: false,
        onLiveToggle: () => {},
        search: NO_SEARCH,
        onSearchChange: () => {},
        timestamps: true,
        onDownload: () => {},
        defaultTail: 500,
    };

    const messageCell = () =>
        screen.getByRole('list', { name: 'Log lines' }).querySelector('[role="listitem"] > span:last-child')!;

    it('keeps the toolbar to one row by holding the display options behind one button', async () => {
        renderWithQuery(<LogViewer {...props} />);
        // Nothing is on the toolbar until it is asked for.
        expect(screen.queryByText('Wrap long lines')).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'View options' }));
        expect(await screen.findByText('Wrap long lines')).toBeInTheDocument();
    });

    it('wraps long lines when asked, and remembers it for the next console', async () => {
        renderWithQuery(<LogViewer {...props} />);
        expect(messageCell().className).not.toContain('whitespace-pre-wrap');

        await userEvent.click(screen.getByRole('button', { name: 'View options' }));
        await userEvent.click(await screen.findByRole('switch', { name: 'Wrap long lines' }));
        expect(messageCell().className).toContain('whitespace-pre-wrap');
        expect(logViewOptions().wrap).toBe(true);
    });

    it('opens already wrapping when that is what was chosen before', () => {
        localStorage.setItem(KEY, JSON.stringify({ wrap: true, timestamps: null, tail: null }));
        resetLogViewOptions();
        renderWithQuery(<LogViewer {...props} />);
        expect(messageCell().className).toContain('whitespace-pre-wrap');
    });

    it('shows the screen’s own tail until one is picked, then the picked one everywhere', async () => {
        const { unmount } = renderWithQuery(<LogViewer {...props} defaultTail={500} />);
        await userEvent.click(screen.getByRole('button', { name: 'View options' }));
        // The screen's default is among the sizes offered, so the picker always has a value.
        expect(await screen.findByRole('combobox', { name: 'Tail' })).toHaveTextContent('500');
        await userEvent.click(screen.getByRole('combobox', { name: 'Tail' }));
        await userEvent.click(await screen.findByRole('option', { name: '1,000' }));
        expect(logViewOptions().tail).toBe(1000);
        unmount();

        // A console whose screen reads a different tail by default now reads the chosen one too.
        renderWithQuery(<LogViewer {...props} defaultTail={100} />);
        await userEvent.click(screen.getByRole('button', { name: 'View options' }));
        expect(await screen.findByRole('combobox', { name: 'Tail' })).toHaveTextContent('1,000');
    });

    it('stamps lines as the screen asked until the reader says otherwise', async () => {
        const stamp = '2026-09-21T10:00:00Z';
        // A screen that stamps its lines, as a pod's console does.
        const { unmount } = renderWithQuery(<LogViewer {...props} timestamps />);
        expect(screen.getByText(stamp)).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'View options' }));
        await userEvent.click(await screen.findByRole('switch', { name: 'Show timestamps' }));
        expect(screen.queryByText(stamp)).not.toBeInTheDocument();
        expect(logViewOptions().timestamps).toBe(false);
        unmount();

        // The answer holds for a console that would not have stamped them either.
        renderWithQuery(<LogViewer {...props} timestamps={false} />);
        expect(screen.queryByText(stamp)).not.toBeInTheDocument();
    });

    it('turns the stamp on for a screen that leaves it off', async () => {
        renderWithQuery(<LogViewer {...props} timestamps={false} />);
        expect(screen.queryByText('2026-09-21T10:00:00Z')).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'View options' }));
        await userEvent.click(await screen.findByRole('switch', { name: 'Show timestamps' }));
        expect(screen.getByText('2026-09-21T10:00:00Z')).toBeInTheDocument();
    });
});
