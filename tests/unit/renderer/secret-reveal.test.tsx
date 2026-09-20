import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from './helpers';

const invoke = vi.fn();
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
}));

const toasts = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', async () => ({
    ...(await vi.importActual<typeof import('sonner')>('sonner')),
    toast: toasts,
}));

const { IpcError } = await import('@/lib/ipc');
const { REVEAL_TIMEOUT_MS, useSecretReveal } = await import('@/lib/secret-reveal');
const { SecretKeysCard } = await import('@/components/secret/keys-card');

const entries = [
    { key: 'password', masked: '••••••••' },
    { key: 'token', masked: '••••••••' },
];
const value = { key: 'password', value: 'super-secret-value', binary: false };

const writeText = vi.fn(async () => {});

beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(value);
    toasts.success.mockReset();
    toasts.error.mockReset();
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
});

describe('useSecretReveal', () => {
    afterEach(() => vi.useRealTimers());

    it('asks for the one key revealed and masks it again on the timer', async () => {
        vi.useFakeTimers();
        const { result } = renderHook(() => useSecretReveal('app-secret', 'team-a'));

        await act(async () => result.current.toggle('password'));
        expect(invoke).toHaveBeenCalledExactlyOnceWith('secrets.reveal', {
            name: 'app-secret',
            namespace: 'team-a',
            key: 'password',
        });
        expect(result.current.shown('password')).toEqual(value);
        expect(result.current.shown('token')).toBeUndefined();

        act(() => vi.advanceTimersByTime(REVEAL_TIMEOUT_MS));
        expect(result.current.shown('password')).toBeUndefined();
    });

    it('hides a revealed value again on a second click, before the timer runs out', async () => {
        vi.useFakeTimers();
        const { result } = renderHook(() => useSecretReveal('app-secret', 'team-a'));

        await act(async () => result.current.toggle('password'));
        act(() => result.current.toggle('password'));
        expect(result.current.shown('password')).toBeUndefined();

        // The timer of the value already hidden must not fire against a later reveal.
        await act(async () => result.current.toggle('password'));
        act(() => vi.advanceTimersByTime(REVEAL_TIMEOUT_MS / 2));
        expect(result.current.shown('password')).toEqual(value);
    });

    it('copies without ever putting the value on screen', async () => {
        const { result } = renderHook(() => useSecretReveal('app-secret', 'team-a'));

        await act(async () => result.current.copy('password'));
        expect(writeText).toHaveBeenCalledWith('super-secret-value');
        expect(result.current.shown('password')).toBeUndefined();
        expect(toasts.success).toHaveBeenCalledWith('“password” copied', expect.anything());
    });

    it('reports a clipboard that refused rather than claiming the value was copied', async () => {
        writeText.mockRejectedValue(new Error('denied'));
        const { result } = renderHook(() => useSecretReveal('app-secret', 'team-a'));

        await act(async () => result.current.copy('password'));
        expect(toasts.success).not.toHaveBeenCalled();
        expect(toasts.error).toHaveBeenCalledWith('Copy failed', expect.anything());
    });

    it('reports a refused read and a key that has gone, leaving the row masked', async () => {
        invoke.mockRejectedValueOnce(new IpcError({ kind: 'forbidden', detail: 'denied', op: 'secrets.reveal' }));
        const { result } = renderHook(() => useSecretReveal('app-secret', 'team-a'));

        await act(async () => result.current.toggle('password'));
        expect(toasts.error).toHaveBeenCalledWith('Access denied', { description: 'denied' });
        expect(result.current.shown('password')).toBeUndefined();

        invoke.mockResolvedValueOnce(null);
        await act(async () => result.current.toggle('password'));
        expect(toasts.error).toHaveBeenLastCalledWith('Key not found', expect.anything());
        expect(result.current.shown('password')).toBeUndefined();
    });
});

describe('the Keys card', () => {
    it('masks every value until one is revealed, and copies without showing it', async () => {
        renderWithQuery(<SecretKeysCard name="app-secret" namespace="team-a" entries={entries} />);
        const table = screen.getByTestId('secret-keys');
        expect(within(table).getAllByText('••••••••')).toHaveLength(2);

        await userEvent.click(within(table).getByRole('button', { name: 'Reveal password' }));
        await waitFor(() => expect(screen.getByTestId('value-password')).toHaveTextContent('super-secret-value'));
        // Only the key asked for: the other row is still masked and no second read was made.
        expect(within(table).getAllByText('••••••••')).toHaveLength(1);
        expect(invoke).toHaveBeenCalledExactlyOnceWith('secrets.reveal', {
            name: 'app-secret',
            namespace: 'team-a',
            key: 'password',
        });

        await userEvent.click(within(table).getByRole('button', { name: 'Hide password' }));
        expect(screen.queryByTestId('value-password')).not.toBeInTheDocument();

        await userEvent.click(within(table).getByRole('button', { name: 'Copy token' }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith('super-secret-value'));
        expect(screen.queryByTestId('value-token')).not.toBeInTheDocument();
    });

    it('labels a value that is not text as base64', async () => {
        invoke.mockResolvedValue({ key: 'password', value: 'MIL//g==', binary: true });
        renderWithQuery(<SecretKeysCard name="app-secret" namespace="team-a" entries={entries} />);

        await userEvent.click(screen.getByRole('button', { name: 'Reveal password' }));
        const shown = await screen.findByTestId('value-password');
        expect(shown).toHaveTextContent('MIL//g==');
        expect(shown).toHaveTextContent('(base64)');
    });
});
