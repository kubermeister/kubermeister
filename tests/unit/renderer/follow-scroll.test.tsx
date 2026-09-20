import { act, fireEvent, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogLine } from '../../../src/shared/k8s/logs';
import { LogViewer, SINCE_OPTIONS } from '@/components/data-display/log-viewer';
import { BOTTOM_SLACK_PX, isAtBottom, useFollowBottom } from '@/lib/follow-scroll';
import { NO_SEARCH } from '@/lib/log-filter';
import { renderWithQuery } from './helpers';

/** jsdom lays nothing out, so the scroll geometry the follow reads is stood in for here. */
function measure(element: HTMLElement, clientHeight: number, scrollHeight: number) {
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight });
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight });
}

const spare: HTMLElement[] = [];
afterEach(() => spare.splice(0).forEach((element) => element.remove()));

function scrollable(clientHeight = 600, scrollHeight = 1800) {
    const element = document.createElement('div');
    document.body.append(element);
    measure(element, clientHeight, scrollHeight);
    spare.push(element);
    return element;
}

function follow(element: HTMLElement, contentHeight = 1800, resetKey = 'web') {
    const ref = { current: element };
    return renderHook(({ height, key }) => useFollowBottom(ref, height, key), {
        initialProps: { height: contentHeight, key: resetKey },
    });
}

describe('isAtBottom', () => {
    it('reads the end, and a shade above it, as the end', () => {
        expect(isAtBottom({ scrollTop: 1200, clientHeight: 600, scrollHeight: 1800 })).toBe(true);
        expect(isAtBottom({ scrollTop: 1200 - BOTTOM_SLACK_PX, clientHeight: 600, scrollHeight: 1800 })).toBe(true);
        // Over-scroll, which a browser reports mid-gesture, is still the end.
        expect(isAtBottom({ scrollTop: 1400, clientHeight: 600, scrollHeight: 1800 })).toBe(true);
    });

    it('reads a view scrolled back as away from the end', () => {
        expect(isAtBottom({ scrollTop: 1200 - BOTTOM_SLACK_PX - 1, clientHeight: 600, scrollHeight: 1800 })).toBe(
            false,
        );
        expect(isAtBottom({ scrollTop: 0, clientHeight: 600, scrollHeight: 1800 })).toBe(false);
    });
});

describe('useFollowBottom', () => {
    it('goes to the end as the content grows', () => {
        const element = scrollable();
        const { result, rerender } = follow(element);
        expect(result.current.following).toBe(true);
        expect(element.scrollTop).toBe(1800);

        element.scrollTop = 0;
        measure(element, 600, 3600);
        act(() => rerender({ height: 3600, key: 'web' }));
        expect(element.scrollTop).toBe(3600);
    });

    it('stops following when the reader scrolls away and leaves the view alone', () => {
        const element = scrollable();
        const { result, rerender } = follow(element);

        element.scrollTop = 200;
        act(() => result.current.onScroll());
        expect(result.current.following).toBe(false);

        measure(element, 600, 3600);
        act(() => rerender({ height: 3600, key: 'web' }));
        expect(element.scrollTop).toBe(200);
    });

    it('follows again when the reader scrolls back to the end', () => {
        const element = scrollable();
        const { result } = follow(element);
        element.scrollTop = 200;
        act(() => result.current.onScroll());

        element.scrollTop = 1200;
        act(() => result.current.onScroll());
        expect(result.current.following).toBe(true);
    });

    it('resumes on demand, going to the end', () => {
        const element = scrollable();
        const { result } = follow(element);
        element.scrollTop = 200;
        act(() => result.current.onScroll());

        act(() => result.current.resume());
        expect(result.current.following).toBe(true);
        expect(element.scrollTop).toBe(1800);
    });

    it('is inert before the container is mounted', () => {
        const ref: { current: HTMLElement | null } = { current: null };
        const { result } = renderHook(() => useFollowBottom(ref, 1800, 'web'));
        act(() => result.current.onScroll());
        act(() => result.current.resume());
        expect(result.current.following).toBe(true);
    });

    it('follows a new log from its end however the last one was left', () => {
        const element = scrollable();
        const { result, rerender } = follow(element);
        element.scrollTop = 200;
        act(() => result.current.onScroll());
        expect(result.current.following).toBe(false);

        act(() => rerender({ height: 1800, key: 'sidecar' }));
        expect(result.current.following).toBe(true);
        expect(element.scrollTop).toBe(1800);
    });
});

describe('LogViewer follow', () => {
    const line = (message: string): LogLine => ({ level: 'INFO', timestamp: '2026-09-20T10:00:00Z', message });
    const props = {
        lines: [line('one'), line('two')],
        containers: ['web'],
        container: 'web',
        onContainerChange: () => {},
        since: SINCE_OPTIONS[0]!,
        onSinceChange: () => {},
        onLiveToggle: () => {},
        search: NO_SEARCH,
        onSearchChange: () => {},
        timestamps: true,
        onDownload: () => {},
    };

    it('says it is following, and offers the way back once the reader scrolls away', async () => {
        renderWithQuery(<LogViewer {...props} live />);
        const rows = screen.getByTestId('log-rows');
        measure(rows, 600, 1800);
        expect(screen.getByTestId('log-viewer')).toHaveAttribute('data-following', 'true');
        expect(screen.getByTestId('log-status')).toHaveTextContent('following');
        expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();

        rows.scrollTop = 0;
        fireEvent.scroll(rows);
        expect(screen.getByTestId('log-viewer')).toHaveAttribute('data-following', 'false');
        expect(screen.getByTestId('log-status')).toHaveTextContent('not following');

        await userEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
        expect(screen.getByTestId('log-viewer')).toHaveAttribute('data-following', 'true');
        expect(rows.scrollTop).toBe(1800);
    });

    it('offers no way back with the stream off, since nothing is arriving', () => {
        renderWithQuery(<LogViewer {...props} live={false} />);
        const rows = screen.getByTestId('log-rows');
        measure(rows, 600, 1800);
        rows.scrollTop = 0;
        fireEvent.scroll(rows);
        expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
        expect(screen.getByTestId('log-status')).toHaveTextContent('snapshot');
    });
});
