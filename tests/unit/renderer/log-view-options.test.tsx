import { act, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogLine } from '../../../src/shared/k8s/logs';
import { LogViewer, SINCE_OPTIONS } from '@/components/data-display/log-viewer';
import { NO_SEARCH } from '@/lib/log-filter';
import {
    DEFAULT_LOG_VIEW_OPTIONS,
    readLogViewOptions,
    useLogViewOptions,
    writeLogViewOptions,
} from '@/lib/log-view-options';
import { renderWithQuery } from './helpers';

const KEY = 'km-log-view';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('log view options', () => {
    it('starts from the defaults when nothing was ever chosen', () => {
        expect(readLogViewOptions()).toEqual(DEFAULT_LOG_VIEW_OPTIONS);
    });

    it('round-trips a choice', () => {
        writeLogViewOptions({ wrap: true });
        expect(readLogViewOptions().wrap).toBe(true);
    });

    it('falls back to the defaults for anything it cannot read', () => {
        for (const raw of ['not json', 'null', '[]', '"wrap"', '{"wrap":"yes"}']) {
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
        expect(() => writeLogViewOptions({ wrap: true })).not.toThrow();
    });

    it('writes each change back as it is made', () => {
        const { result } = renderHook(() => useLogViewOptions());
        expect(result.current[0].wrap).toBe(false);
        act(() => result.current[1]({ wrap: true }));
        expect(result.current[0].wrap).toBe(true);
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
        expect(readLogViewOptions().wrap).toBe(true);
    });

    it('opens already wrapping when that is what was chosen before', () => {
        writeLogViewOptions({ wrap: true });
        renderWithQuery(<LogViewer {...props} />);
        expect(messageCell().className).toContain('whitespace-pre-wrap');
    });
});
