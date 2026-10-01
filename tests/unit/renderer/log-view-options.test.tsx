import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogLine } from '../../../src/shared/k8s/logs';
import { LogViewer, SINCE_OPTIONS } from '@/components/data-display/log-viewer';
import { NO_SEARCH } from '@/lib/log-filter';
import { formatLogTimestamp } from '@/lib/log-timestamp';
import {
    DEFAULT_LOG_VIEW_OPTIONS,
    logViewOptions,
    readLogViewOptions,
    resetLogViewOptions,
    setLogViewOptions,
    useLogViewOptions,
} from '@/lib/log-view-options';
import { renderWithQuery } from './helpers';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', async () => ({
    ...(await vi.importActual<typeof import('sonner')>('sonner')),
    toast: toasts,
}));

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
        setLogViewOptions({ wrap: true, timestamps: false, tail: 1000, podNames: false });
        resetLogViewOptions();
        expect(readLogViewOptions()).toEqual({ wrap: true, timestamps: false, tail: 1000, podNames: false });
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
        for (const raw of [
            'not json',
            'null',
            '[]',
            '"wrap"',
            '{"wrap":"yes","timestamps":1,"tail":"500","podNames":"no"}',
        ]) {
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

describe('the console’s display controls', () => {
    const RAW_STAMP = '2026-09-21T10:00:00Z';
    const stamp = formatLogTimestamp(RAW_STAMP);
    const line = (message: string): LogLine => ({ timestamp: RAW_STAMP, message });
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

    const firstRow = () => screen.getByRole('list', { name: 'Log lines' }).querySelector('[role="listitem"]')!;

    it('puts every display option on the toolbar, with no menu to open first', () => {
        renderWithQuery(<LogViewer {...props} />);
        expect(screen.queryByRole('button', { name: 'View options' })).not.toBeInTheDocument();
        for (const name of ['Wrap long lines', 'Show timestamps']) {
            const toggle = screen.getByRole('button', { name });
            // An icon and nothing else, so the name is all a screen reader has.
            expect(toggle).toHaveTextContent('');
            expect(toggle.querySelector('svg')).toBeInTheDocument();
        }
        expect(screen.getByRole('button', { name: 'Tail' })).toBeInTheDocument();
        // How a line reads is one group, apart from the search's own toggles.
        const display = screen.getByRole('group', { name: 'Line display' });
        expect(
            within(display)
                .getAllByRole('button')
                .map((button) => button.getAttribute('aria-label')),
        ).toEqual(['Wrap long lines', 'Show timestamps']);
        // A console following one pod labels no line with a pod, so it has no pod names to hide.
        expect(screen.queryByRole('button', { name: 'Show pod names' })).not.toBeInTheDocument();
    });

    it('wraps long lines when asked, and remembers it for the next console', async () => {
        renderWithQuery(<LogViewer {...props} />);
        const wrap = screen.getByRole('button', { name: 'Wrap long lines' });
        expect(wrap).toHaveAttribute('aria-pressed', 'false');
        expect(firstRow().className).toContain('whitespace-nowrap');

        await userEvent.click(wrap);
        expect(wrap).toHaveAttribute('aria-pressed', 'true');
        // The whole row wraps as one run of text, so the message continues under its labels.
        expect(firstRow().className).toContain('whitespace-pre-wrap');
        expect(firstRow().className).not.toContain('flex');
        expect(logViewOptions().wrap).toBe(true);
    });

    it('opens already wrapping when that is what was chosen before', () => {
        localStorage.setItem(KEY, JSON.stringify({ wrap: true, timestamps: null, tail: null }));
        resetLogViewOptions();
        renderWithQuery(<LogViewer {...props} />);
        expect(firstRow().className).toContain('whitespace-pre-wrap');
    });

    it('keeps a label whole however the message around it wraps', () => {
        setLogViewOptions({ wrap: true });
        renderWithQuery(<LogViewer {...props} />);
        expect(screen.getByText(stamp).className).toContain('whitespace-nowrap');
    });

    it('shows the screen’s own tail until one is picked, then the picked one everywhere', async () => {
        const { unmount } = renderWithQuery(<LogViewer {...props} defaultTail={500} />);
        // The screen's default is among the sizes offered, so the picker always has a value.
        expect(screen.getByRole('button', { name: 'Tail' })).toHaveTextContent('500');
        await userEvent.click(screen.getByRole('button', { name: 'Tail' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: '1,000' }));
        expect(logViewOptions().tail).toBe(1000);
        unmount();

        // A console whose screen reads a different tail by default now reads the chosen one too.
        renderWithQuery(<LogViewer {...props} defaultTail={100} />);
        expect(screen.getByRole('button', { name: 'Tail' })).toHaveTextContent('1,000');
    });

    it('stamps lines as the screen asked until the reader says otherwise', async () => {
        // A screen that stamps its lines, as a pod's console does.
        const { unmount } = renderWithQuery(<LogViewer {...props} timestamps />);
        expect(screen.getByText(stamp)).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Show timestamps' }));
        expect(screen.queryByText(stamp)).not.toBeInTheDocument();
        expect(logViewOptions().timestamps).toBe(false);
        unmount();

        // The answer holds for a console that would not have stamped them either.
        renderWithQuery(<LogViewer {...props} timestamps={false} />);
        expect(screen.queryByText(stamp)).not.toBeInTheDocument();
    });

    it('turns the stamp on for a screen that leaves it off', async () => {
        renderWithQuery(<LogViewer {...props} timestamps={false} />);
        expect(screen.queryByText(stamp)).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Show timestamps' }));
        // In the reader's zone, with the stamp the API server wrote kept as its title.
        expect(screen.getByText(stamp)).toHaveAttribute('title', RAW_STAMP);
    });

    it('hides the pod names of a console following several pods, and remembers it', async () => {
        const pods = new Map([
            ['web-7d9f-abcde', 'text-primary'],
            ['web-7d9f-xyz12', 'text-ok'],
        ]);
        const lines = [
            { ...line('from one'), pod: 'web-7d9f-abcde' },
            { ...line('from two'), pod: 'web-7d9f-xyz12' },
        ];
        renderWithQuery(<LogViewer {...props} lines={lines} podColors={pods} />);
        const list = screen.getByRole('list', { name: 'Log lines' });
        expect(list.querySelectorAll('[data-pod]')).toHaveLength(2);

        await userEvent.click(screen.getByRole('button', { name: 'Show pod names' }));
        expect(list.querySelectorAll('[data-pod]')).toHaveLength(0);
        expect(within(list).getByText('from one')).toBeInTheDocument();
        expect(logViewOptions().podNames).toBe(false);
    });
});

describe('copying the console', () => {
    const RAW_STAMP = '2026-09-21T10:00:00Z';
    const writeText = vi.fn((_text: string) => Promise.resolve());
    const props = {
        lines: [
            { timestamp: RAW_STAMP, message: 'first', pod: 'web-7d9f-abcde' },
            { timestamp: RAW_STAMP, message: 'second', pod: 'web-7d9f-xyz12' },
        ],
        podColors: new Map([
            ['web-7d9f-abcde', 'text-primary'],
            ['web-7d9f-xyz12', 'text-ok'],
        ]),
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
        defaultTail: 100,
    };
    // Every line as the console reads it: the pod's distinguishing part, the stamp, the message.
    const stamp = formatLogTimestamp(RAW_STAMP);
    const expected = `[abcde] ${stamp} first\n[xyz12] ${stamp} second`;

    beforeEach(() => {
        writeText.mockReset();
        writeText.mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        toasts.success.mockReset();
        toasts.error.mockReset();
    });

    it('copies every line of the buffer from the toolbar and says how many', async () => {
        renderWithQuery(<LogViewer {...props} />);
        fireEvent.click(screen.getByRole('button', { name: 'Copy logs' }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));
        expect(toasts.success).toHaveBeenCalledWith('2 lines copied');
    });

    it('copies the parts on screen only, so a hidden column stays out of the text', async () => {
        setLogViewOptions({ timestamps: false, podNames: false });
        renderWithQuery(<LogViewer {...props} />);
        fireEvent.click(screen.getByRole('button', { name: 'Copy logs' }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith('first\nsecond'));
    });

    it('reports a clipboard that refused rather than claiming the log was copied', async () => {
        writeText.mockRejectedValue(new Error('denied'));
        renderWithQuery(<LogViewer {...props} />);
        fireEvent.click(screen.getByRole('button', { name: 'Copy logs' }));
        await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Could not copy the log', expect.anything()));
        expect(toasts.success).not.toHaveBeenCalled();
    });

    it('has nothing to copy from an empty console', () => {
        renderWithQuery(<LogViewer {...props} lines={[]} />);
        expect(screen.getByRole('button', { name: 'Copy logs' })).toBeDisabled();
    });

    it('selects the log rather than the window on ⌘A, and a copy then carries the whole buffer', () => {
        renderWithQuery(<LogViewer {...props} />);
        const rows = screen.getByTestId('log-rows');
        const keyDown = fireEvent.keyDown(rows, { key: 'a', metaKey: true });
        // Handled here, so the window's own Select All never runs.
        expect(keyDown).toBe(false);
        expect(window.getSelection()?.toString()).toContain('first');

        const setData = vi.fn();
        fireEvent.copy(rows, { clipboardData: { setData } });
        expect(setData).toHaveBeenCalledWith('text/plain', expected);
    });

    it('leaves a selection the reader made to the browser', () => {
        renderWithQuery(<LogViewer {...props} />);
        const rows = screen.getByTestId('log-rows');
        fireEvent.keyDown(rows, { key: 'a', metaKey: true });
        // A press in the log starts a selection of the reader's own.
        fireEvent.mouseDown(rows);
        const setData = vi.fn();
        fireEvent.copy(rows, { clipboardData: { setData } });
        expect(setData).not.toHaveBeenCalled();
    });

    it('leaves other chords alone', () => {
        renderWithQuery(<LogViewer {...props} />);
        expect(fireEvent.keyDown(screen.getByTestId('log-rows'), { key: 'a' })).toBe(true);
        expect(fireEvent.keyDown(screen.getByTestId('log-rows'), { key: 'a', metaKey: true, shiftKey: true })).toBe(
            true,
        );
    });
});
