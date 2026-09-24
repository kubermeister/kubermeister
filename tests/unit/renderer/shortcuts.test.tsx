import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoutes } from './helpers';
import { settingsFixture } from './settings-fixture';
import { SHORTCUTS, formatChord, shortcutById } from '../../../src/shared/shortcuts';

const invoke = vi.fn();
const pushes = new Map<string, (payload: unknown) => void>();
const subscribe = vi.fn((channel: string, handler: (payload: unknown) => void) => {
    pushes.set(channel, handler);
    return () => pushes.delete(channel);
});
const stream = vi.fn(() => ({ stop: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    subscribe,
    stream,
}));

const { routeTree } = await import('@/routeTree.gen');
const { chordAllowed, focusScreenSearch, focusZone, overlayOpen } = await import('@/lib/shortcuts');

const data: Record<string, unknown> = {
    'update.state': { status: 'up-to-date' },
    'settings.get': settingsFixture(),
    'contexts.list': [],
    'namespaces.list': [],
    'namespace.active': { name: 'default' },
    'resources.list': { kind: 'Pod', items: [] },
};

const listCalls = () => invoke.mock.calls.filter(([channel]) => channel === 'resources.list').length;

/** A stand-in for a widget the rules recognise by its root class, with a field focused inside. */
function focusInside(rootClass: string): HTMLElement {
    const root = document.createElement('div');
    root.className = rootClass;
    const field = document.createElement('textarea');
    root.append(field);
    document.body.append(root);
    field.focus();
    return root;
}

describe('the shortcut focus rules', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('tells a terminal, the editor and a text field apart from the rest of the page', () => {
        expect(focusZone(focusInside('xterm').querySelector('textarea'))).toBe('terminal');
        expect(focusZone(focusInside('cm-editor').querySelector('textarea'))).toBe('editor');
        const input = document.createElement('input');
        document.body.append(input);
        expect(focusZone(input)).toBe('text');
        expect(focusZone(document.body)).toBe('none');
        expect(focusZone(null)).toBe('none');
        expect(focusZone(window)).toBe('none');
    });

    it('keeps single keys out of every field', () => {
        const slash = shortcutById('search').keys.other[0]!;
        expect(chordAllowed(slash, 'none', 'other')).toBe(true);
        for (const zone of ['text', 'editor', 'terminal'] as const)
            expect(chordAllowed(slash, zone, 'other')).toBe(false);
    });

    it('leaves a terminal every key a shell could read, which on macOS spares only ⌘ chords', () => {
        for (const shortcut of SHORTCUTS) {
            for (const chord of shortcut.keys.other) expect(chordAllowed(chord, 'terminal', 'other')).toBe(false);
        }
        const [paletteCmd, paletteCtrl] = shortcutById('palette').keys.mac;
        expect(chordAllowed(paletteCmd!, 'terminal', 'mac')).toBe(true);
        expect(chordAllowed(paletteCtrl!, 'terminal', 'mac')).toBe(false);
        expect(chordAllowed(shortcutById('refresh').keys.mac[0]!, 'terminal', 'mac')).toBe(true);
    });

    it('lets the editor keep its own chords and nothing else', () => {
        expect(chordAllowed(shortcutById('search').keys.other[1]!, 'editor', 'other')).toBe(false);
        expect(chordAllowed(shortcutById('back').keys.mac[0]!, 'editor', 'mac')).toBe(false);
        expect(chordAllowed(shortcutById('refresh').keys.other[0]!, 'editor', 'other')).toBe(true);
        expect(chordAllowed(shortcutById('palette').keys.other[0]!, 'editor', 'other')).toBe(true);
        expect(chordAllowed(shortcutById('domain.network').keys.other[0]!, 'editor', 'other')).toBe(true);
        expect(chordAllowed(shortcutById('search').keys.other[1]!, 'text', 'other')).toBe(true);
    });

    it('sees an open dialog, menu or listbox', () => {
        expect(overlayOpen()).toBe(false);
        const menu = document.createElement('div');
        menu.setAttribute('role', 'menu');
        document.body.append(menu);
        expect(overlayOpen()).toBe(true);
    });

    it('focuses the visible search box and reports a screen without one', () => {
        expect(focusScreenSearch()).toBe(false);
        document.body.innerHTML =
            '<div hidden><input data-screen-search id="hidden" /></div><input data-screen-search id="shown" value="web" />';
        expect(focusScreenSearch()).toBe(true);
        expect(document.activeElement?.id).toBe('shown');
        expect((document.activeElement as HTMLInputElement).selectionStart).toBe(0);
    });
});

describe('the shortcut dispatcher', () => {
    beforeEach(() => {
        localStorage.clear();
        pushes.clear();
        invoke.mockReset();
        invoke.mockImplementation(async (channel: string) => data[channel] ?? null);
    });
    afterEach(() => {
        document.querySelectorAll('.xterm, .cm-editor').forEach((el) => el.remove());
    });

    it('goes to a domain by number, landing on its first screen', async () => {
        const { router } = renderRoutes(routeTree, '/overview/summary');
        await screen.findByTestId('sidebar');
        await userEvent.keyboard('{Control>}2{/Control}');
        await waitFor(() => expect(router.state.location.pathname).toBe('/workloads/pods'));
        await userEvent.keyboard('{Control>}6{/Control}');
        await waitFor(() => expect(router.state.location.pathname).toBe('/addons/charts'));
        // user-event's key map has no Comma, so the key is named by its position.
        await userEvent.keyboard('{Control>}[Comma]{/Control}');
        await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
    });

    it('walks back and forward by key and by the mouse buttons', async () => {
        const { router } = renderRoutes(routeTree, '/overview/summary');
        await screen.findByTestId('sidebar');
        await userEvent.keyboard('{Control>}3{/Control}');
        await waitFor(() => expect(router.state.location.pathname).toBe('/network/services'));
        await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
        await waitFor(() => expect(router.state.location.pathname).toBe('/overview/summary'));
        await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}');
        await waitFor(() => expect(router.state.location.pathname).toBe('/network/services'));
        fireEvent.mouseUp(document.body, { button: 3 });
        await waitFor(() => expect(router.state.location.pathname).toBe('/overview/summary'));
        fireEvent.mouseUp(document.body, { button: 4 });
        await waitFor(() => expect(router.state.location.pathname).toBe('/network/services'));
        fireEvent.mouseUp(document.body, { button: 0 });
        expect(router.state.location.pathname).toBe('/network/services');
    });

    it("focuses the list's search box with / and with Mod+F", async () => {
        renderRoutes(routeTree, '/workloads/pods');
        const search = await screen.findByRole('textbox', { name: /Search/ });
        await userEvent.keyboard('/');
        expect(search).toHaveFocus();
        // Typed into the box, `/` is a character again.
        await userEvent.keyboard('a/');
        expect(search).toHaveValue('a/');
        search.blur();
        await userEvent.keyboard('{Control>}f{/Control}');
        expect(search).toHaveFocus();
    });

    it("refetches the screen's data with Mod+R and from the View menu's Refresh", async () => {
        renderRoutes(routeTree, '/workloads/pods');
        await screen.findByRole('textbox', { name: /Search/ });
        await waitFor(() => expect(listCalls()).toBeGreaterThan(0));
        const before = listCalls();
        await userEvent.keyboard('{Control>}r{/Control}');
        await waitFor(() => expect(listCalls()).toBe(before + 1));
        act(() => pushes.get('shortcut')!({ id: 'refresh' }));
        await waitFor(() => expect(listCalls()).toBe(before + 2));
    });

    it('opens a cheat sheet listing every shortcut the platform has, from ?, the menu and the palette', async () => {
        renderRoutes(routeTree, '/overview/summary');
        await screen.findByTestId('sidebar');
        await userEvent.keyboard('?');
        const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
        const listed = SHORTCUTS.filter((s) => s.keys.other.length > 0);
        for (const shortcut of listed) {
            const row = within(sheet).getByText(shortcut.label).parentElement!;
            for (const chord of shortcut.keys.other) expect(row).toHaveTextContent(formatChord(chord, 'other'));
        }
        // Quit has no key outside macOS, so it is not on this sheet.
        expect(within(sheet).queryByText(shortcutById('quit').label)).not.toBeInTheDocument();
        expect(
            within(sheet)
                .getAllByRole('region')
                .map((r) => r.getAttribute('aria-label')),
        ).toEqual(['Navigation', 'Screen', 'App']);
        await userEvent.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

        act(() => pushes.get('shortcut')!({ id: 'cheatSheet' }));
        expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
        await userEvent.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

        await userEvent.keyboard('{Control>}k{/Control}');
        const palette = await screen.findByRole('dialog', { name: 'Quick actions' });
        await userEvent.click(within(palette).getByRole('option', { name: /Keyboard shortcuts/ }));
        expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: 'Quick actions' })).not.toBeInTheDocument();
    });

    it('does nothing behind an open dialog, except closing the palette with its own key', async () => {
        const { router } = renderRoutes(routeTree, '/overview/summary');
        await screen.findByTestId('sidebar');
        await userEvent.keyboard('?');
        await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
        await userEvent.keyboard('{Control>}2{/Control}');
        await userEvent.keyboard('{Control>}k{/Control}');
        expect(router.state.location.pathname).toBe('/overview/summary');
        expect(screen.queryByRole('dialog', { name: 'Quick actions' })).not.toBeInTheDocument();
        await userEvent.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

        await userEvent.keyboard('{Control>}k{/Control}');
        await screen.findByRole('dialog', { name: 'Quick actions' });
        await userEvent.keyboard('{Control>}k{/Control}');
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('yields every chord to a focused terminal and the chords it binds to the editor', async () => {
        const { router } = renderRoutes(routeTree, '/overview/summary');
        await screen.findByTestId('sidebar');
        focusInside('xterm');
        await userEvent.keyboard('{Control>}2{/Control}');
        await userEvent.keyboard('{Control>}k{/Control}');
        await userEvent.keyboard('?');
        expect(router.state.location.pathname).toBe('/overview/summary');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        focusInside('cm-editor');
        await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
        await userEvent.keyboard('/');
        expect(router.state.location.pathname).toBe('/overview/summary');
        await userEvent.keyboard('{Control>}2{/Control}');
        await waitFor(() => expect(router.state.location.pathname).toBe('/workloads/pods'));
    });

    it('leaves the keys the menu handles, and a held key, alone', async () => {
        const { router } = renderRoutes(routeTree, '/overview/summary');
        await screen.findByTestId('sidebar');
        const forceReload = fireEvent.keyDown(document.body, { code: 'KeyR', key: 'R', ctrlKey: true, shiftKey: true });
        // Not cancelled, so the menu's own accelerator still runs.
        expect(forceReload).toBe(true);
        expect(fireEvent.keyDown(document.body, { code: 'Digit2', key: '2', ctrlKey: true, repeat: true })).toBe(true);
        expect(router.state.location.pathname).toBe('/overview/summary');
        // A screen with no search box lets `/` through untouched.
        expect(fireEvent.keyDown(document.body, { code: 'Slash', key: '/' })).toBe(true);
    });
});
