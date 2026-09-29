import { createRootRoute, createRoute, Link, Outlet, useParams } from '@tanstack/react-router';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { objectRemountDeps } from '@/lib/remount';
import { renderRoutes } from './helpers';

describe('objectRemountDeps', () => {
    it('names the object by every path parameter except the tab', () => {
        expect(objectRemountDeps({ params: { namespace: 'team-a', name: 'web', tab: 'logs' } })).toEqual({
            namespace: 'team-a',
            name: 'web',
        });
        expect(objectRemountDeps({ params: { name: 'node-1' } })).toEqual({ name: 'node-1' });
        expect(objectRemountDeps({ params: {} })).toEqual({});
    });
});

function Detail() {
    const { name, tab } = useParams({ strict: false });
    // Stands for any local state a detail screen holds: a revealed value, an edited manifest.
    const [typed, setTyped] = useState('');
    return (
        <div>
            <p data-testid="where">
                {name}/{tab ?? 'overview'}
            </p>
            <input aria-label="Local state" value={typed} onChange={(event) => setTyped(event.target.value)} />
            <Link to="/things/$name/{-$tab}" params={{ name: 'a', tab: 'logs' }}>
                A logs
            </Link>
            <Link to="/things/$name/{-$tab}" params={{ name: 'b', tab: undefined }}>
                B
            </Link>
        </div>
    );
}

function tree() {
    const root = createRootRoute({ component: Outlet });
    const detail = createRoute({ getParentRoute: () => root, path: '/things/$name/{-$tab}', component: Detail });
    return root.addChildren([detail]);
}

describe('a detail route under the app’s remount rule', () => {
    it('keeps local state across a tab switch and drops it on another object', async () => {
        renderRoutes(tree(), '/things/a');
        await userEvent.type(await screen.findByRole('textbox', { name: 'Local state' }), 'from a');

        await userEvent.click(screen.getByRole('link', { name: 'A logs' }));
        await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('a/logs'));
        expect(screen.getByRole('textbox', { name: 'Local state' })).toHaveValue('from a');

        await userEvent.click(screen.getByRole('link', { name: 'B' }));
        await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('b/overview'));
        expect(screen.getByRole('textbox', { name: 'Local state' })).toHaveValue('');
    });
});
