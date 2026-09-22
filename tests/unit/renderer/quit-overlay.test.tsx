import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuitHold } from '../../../src/shared/ipc';

const invoke = vi.fn(async () => ({ ok: true }));
let push: ((state: QuitHold) => void) | undefined;
const unsubscribe = vi.fn();
const subscribe = vi.fn((_channel: string, handler: (state: QuitHold) => void) => {
    push = handler;
    return unsubscribe;
});
vi.mock('@/lib/ipc', () => ({ invoke, subscribe }));

const { QuitOverlay } = await import('@/components/layout/quit-overlay');

const hint = () => screen.getByTestId('quit-hold');

describe('QuitOverlay', () => {
    beforeEach(() => {
        invoke.mockClear();
        subscribe.mockClear();
        unsubscribe.mockClear();
        push = undefined;
    });

    it('tells main a hint can be shown, and takes it back when it goes', async () => {
        const view = render(<QuitOverlay />);
        await act(async () => {});
        expect(invoke).toHaveBeenCalledWith('quit.overlayReady', { ready: true });
        expect(subscribe).toHaveBeenCalledWith('quit.hold', expect.any(Function));

        view.unmount();
        await act(async () => {});
        expect(invoke).toHaveBeenLastCalledWith('quit.overlayReady', { ready: false });
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('shows the hint while the keys are held and fades it when they go', async () => {
        render(<QuitOverlay />);
        await act(async () => {});
        expect(hint()).toHaveAttribute('aria-hidden', 'true');

        act(() => push?.({ holding: true }));
        expect(hint()).toHaveAttribute('aria-hidden', 'false');
        expect(hint()).toHaveTextContent('Hold ⌘Q to Quit');

        act(() => push?.({ holding: false }));
        expect(hint()).toHaveAttribute('aria-hidden', 'true');
    });
});
