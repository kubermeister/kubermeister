import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoutes } from './helpers';

const invoke = vi.fn();
const subscribe = vi.fn(() => () => {});
const stream = vi.fn(() => ({ stop: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    subscribe,
    stream,
}));

const { routeTree } = await import('@/routeTree.gen');

describe('the Settings gear', () => {
    beforeEach(() => {
        localStorage.clear();
        invoke.mockReset();
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'update.state') return { status: 'up-to-date' };
            return channel.endsWith('.list') ? [] : null;
        });
    });

    it('ends the top bar, after Create resource', async () => {
        renderRoutes(routeTree, '/overview/summary');
        const bar = await screen.findByTestId('top-bar');
        const settings = within(bar).getByTestId('settings-button');
        expect(settings).toHaveAccessibleName('Settings');
        expect(settings).toHaveAttribute('href', '/settings');
        expect(settings).not.toHaveAttribute('aria-current');
        const create = within(bar).getByRole('link', { name: 'Create resource' });
        expect(create.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(within(bar).getAllByRole('link').at(-1)).toBe(settings);
    });

    it('names its keys in the tooltip, one keycap per key', async () => {
        renderRoutes(routeTree, '/overview/summary');
        (await screen.findByTestId('settings-button')).focus();
        const tooltip = await screen.findByRole('tooltip');
        expect(tooltip).toHaveTextContent('Settings');
        // jsdom reports no Mac platform, so the keys are the Ctrl ones.
        expect([...tooltip.querySelectorAll('kbd')].map((key) => key.textContent)).toEqual(['Ctrl', ',']);
    });

    it('stays lit on every section of Settings', async () => {
        const { router } = renderRoutes(routeTree, '/overview/summary');
        const settings = await screen.findByTestId('settings-button');
        await userEvent.click(settings);
        await waitFor(() => expect(settings).toHaveAttribute('aria-current', 'page'));
        await router.navigate({ to: '/settings/{-$section}', params: { section: 'charts' } });
        await waitFor(() => expect(router.state.location.pathname).toBe('/settings/charts'));
        expect(settings).toHaveAttribute('aria-current', 'page');
    });
});
