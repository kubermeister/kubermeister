import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../../src/shared/ipc';

const invoke = vi.fn();
let push: ((state: UpdateState) => void) | undefined;
const unsubscribe = vi.fn();
const subscribe = vi.fn((_channel: string, handler: (state: UpdateState) => void) => {
    push = handler;
    return unsubscribe;
});
vi.mock('@/lib/ipc', () => ({ invoke, subscribe }));
const toast = vi.fn();
vi.mock('sonner', () => ({ toast }));

const { UpdatePill } = await import('@/components/layout/update-pill');

const answer = (state: UpdateState) =>
    invoke.mockImplementation(async (channel: string) => (channel === 'update.state' ? state : { ok: true }));

describe('UpdatePill', () => {
    beforeEach(() => {
        invoke.mockReset();
        toast.mockReset();
        unsubscribe.mockReset();
        push = undefined;
    });

    it('lets a push that arrives before the initial read win', async () => {
        let resolveInitial: (state: UpdateState) => void = () => {};
        invoke.mockReturnValue(new Promise<UpdateState>((resolve) => (resolveInitial = resolve)));
        render(<UpdatePill />);
        act(() => push?.({ status: 'downloaded', version: '0.3.0' }));
        await act(async () => resolveInitial({ status: 'up-to-date' }));
        expect(screen.getByTestId('update-pill')).toHaveTextContent('Restart to update');
    });

    it('renders nothing while up to date, during checks, and for background failures', async () => {
        answer({ status: 'up-to-date' });
        const view = render(<UpdatePill />);
        await act(async () => {});
        expect(screen.queryByTestId('update-pill')).not.toBeInTheDocument();
        act(() => push?.({ status: 'checking' }));
        expect(screen.queryByTestId('update-pill')).not.toBeInTheDocument();
        act(() => push?.({ status: 'error', message: 'offline', background: true }));
        expect(screen.queryByTestId('update-pill')).not.toBeInTheDocument();
        expect(toast).not.toHaveBeenCalled();
        view.unmount();
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('announces a found version once and offers the download from the popover', async () => {
        answer({ status: 'up-to-date' });
        render(<UpdatePill />);
        await act(async () => {});
        const found: UpdateState = {
            status: 'available',
            version: '0.3.0',
            releaseDate: '2026-09-16T06:48:44.854Z',
        };
        act(() => push?.(found));
        const pill = screen.getByTestId('update-pill');
        expect(pill).toHaveTextContent('Update available');
        expect(pill).toHaveAttribute('data-status', 'available');
        expect(toast).toHaveBeenCalledOnce();
        expect(toast).toHaveBeenCalledWith(
            'Version 0.3.0 is available.',
            expect.objectContaining({ description: expect.stringMatching(/^Released .*2026\.$/) as string }),
        );
        // The same version pushed again (a later scheduled check) is not announced twice.
        act(() => push?.({ ...found, checkedAt: '2026-09-16T11:00:00.000Z' }));
        expect(toast).toHaveBeenCalledOnce();

        await userEvent.click(pill);
        const popover = await screen.findByTestId('update-popover');
        expect(popover).toHaveTextContent('Version 0.3.0 is available.');
        // The changelog is not in the popover at all; the link beside the action is the way to it.
        expect(popover).toHaveTextContent(/Released .*2026\./);
        expect(screen.getByRole('link', { name: /What's new/ })).toHaveAttribute(
            'href',
            'https://github.com/kubermeister/kubermeister/releases/tag/v0.3.0',
        );
        await userEvent.click(screen.getByRole('button', { name: 'Update' }));
        expect(invoke).toHaveBeenCalledWith('update.download', {});

        // The toast's own action downloads too.
        const options = toast.mock.calls[0]?.[1] as { action: { onClick: () => void } };
        options.action.onClick();
        expect(invoke.mock.calls.filter(([c]) => c === 'update.download')).toHaveLength(2);
    });

    it('shows download progress and then the restart, announcing readiness', async () => {
        answer({ status: 'downloading', version: '0.3.1', percent: 10 });
        render(<UpdatePill />);
        const pill = await screen.findByTestId('update-pill');
        expect(pill).toHaveTextContent('Downloading 10%');
        await userEvent.click(pill);
        expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '10');
        act(() => push?.({ status: 'downloading', version: '0.3.1', percent: 65 }));
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '65');
        expect(screen.getByRole('link', { name: /What's new/ })).toHaveAttribute(
            'href',
            'https://github.com/kubermeister/kubermeister/releases/tag/v0.3.1',
        );

        act(() => push?.({ status: 'downloaded', version: '0.3.1' }));
        expect(pill).toHaveTextContent('Restart to update');
        expect(toast).toHaveBeenCalledWith(
            'Version 0.3.1 is ready to install.',
            expect.objectContaining({ action: expect.objectContaining({ label: 'Restart' }) }),
        );
        await userEvent.click(screen.getByRole('button', { name: 'Restart now' }));
        expect(invoke).toHaveBeenCalledWith('update.install', {});
        const options = toast.mock.calls[0]?.[1] as { action: { onClick: () => void } };
        options.action.onClick();
        expect(invoke.mock.calls.filter(([c]) => c === 'update.install')).toHaveLength(2);
    });

    it('lets a failure be retried or dismissed until the state moves on', async () => {
        answer({ status: 'error', message: 'feed unreachable' });
        invoke.mockImplementation(async (channel: string) =>
            channel === 'update.check'
                ? { status: 'error', message: 'feed unreachable' }
                : { status: 'error', message: 'feed unreachable' },
        );
        render(<UpdatePill />);
        const pill = await screen.findByTestId('update-pill');
        expect(pill).toHaveTextContent('Update failed');
        await userEvent.click(pill);
        expect(await screen.findByTestId('update-popover')).toHaveTextContent('feed unreachable');
        expect(screen.queryByRole('link', { name: /What's new/ })).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(invoke).toHaveBeenCalledWith('update.check', {});

        await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(screen.queryByTestId('update-pill')).not.toBeInTheDocument();
        act(() => push?.({ status: 'error', message: 'feed unreachable' }));
        expect(screen.queryByTestId('update-pill')).not.toBeInTheDocument();
        act(() => push?.({ status: 'error', message: 'checksum mismatch' }));
        expect(screen.getByTestId('update-pill')).toHaveTextContent('Update failed');
        expect(toast).not.toHaveBeenCalled();
    });
});
