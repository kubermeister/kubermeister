import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RefreshButton } from '@/components/refresh-button';
import { refreshScreen } from '@/lib/refresh';

function renderWith(client: QueryClient, ui: React.ReactElement) {
    return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('RefreshButton', () => {
    it('invalidates every query when no keys are given and spins until settled', async () => {
        const client = new QueryClient();
        let release!: () => void;
        const spy = vi
            .spyOn(client, 'invalidateQueries')
            .mockImplementation(() => new Promise<void>((r) => (release = r)));
        renderWith(client, <RefreshButton />);
        const button = screen.getByRole('button', { name: 'Refresh' });
        await userEvent.click(button);
        expect(spy).toHaveBeenCalledWith();
        expect(button).toHaveAttribute('aria-disabled', 'true');
        expect(button.querySelector('svg')).toHaveClass('animate-spin');
        release();
        await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'false'));
        expect(button.querySelector('svg')).not.toHaveClass('animate-spin');
    });

    it('invalidates only the given keys and shows a text label', async () => {
        const client = new QueryClient();
        const spy = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
        renderWith(client, <RefreshButton queryKeys={[['nodes.list'], ['pods']]} label="Reload" />);
        await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy).toHaveBeenCalledWith({ queryKey: ['nodes.list'] });
        expect(spy).toHaveBeenCalledWith({ queryKey: ['pods'] });
    });

    it("gives Mod+R the newest button's refresh, and every query once none is mounted", async () => {
        const client = new QueryClient();
        const spy = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
        const first = renderWith(client, <RefreshButton queryKeys={[['nodes.list']]} />);
        const second = renderWith(client, <RefreshButton queryKeys={[['pods']]} />);
        await refreshScreen(client);
        expect(spy).toHaveBeenLastCalledWith({ queryKey: ['pods'] });
        second.unmount();
        await refreshScreen(client);
        expect(spy).toHaveBeenLastCalledWith({ queryKey: ['nodes.list'] });
        first.unmount();
        await refreshScreen(client);
        expect(spy).toHaveBeenLastCalledWith();
        expect(spy).toHaveBeenCalledTimes(3);
    });
});
