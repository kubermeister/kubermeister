import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    RouterProvider,
    type AnyRoute,
} from '@tanstack/react-router';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { ThemeProvider } from '@/components/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { objectRemountDeps } from '@/lib/remount';

function testQueryClient(): QueryClient {
    return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

/** Render under the app's providers with a fresh QueryClient and retries off so failures surface immediately. */
export function renderWithQuery(ui: ReactElement): RenderResult {
    const client = testQueryClient();
    // A wrapper rather than nesting, so `rerender` keeps the providers: rendering the bare element
    // again would drop the query client under any component that asks for one.
    const Providers = ({ children }: { children: ReactNode }) => (
        <ThemeProvider>
            <QueryClientProvider client={client}>
                <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
            </QueryClientProvider>
        </ThemeProvider>
    );
    return render(ui, { wrapper: Providers });
}

/** Render a route tree at `path` under the app's providers, on an in-memory history. */
export function renderRoutes(routeTree: AnyRoute, path: string) {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [path] }),
        defaultRemountDeps: objectRemountDeps,
    });
    const result = render(
        <ThemeProvider>
            <QueryClientProvider client={testQueryClient()}>
                <TooltipProvider delayDuration={0}>
                    <RouterProvider router={router} />
                </TooltipProvider>
            </QueryClientProvider>
        </ThemeProvider>,
    );
    return { ...result, router };
}

/**
 * Render one component inside a minimal router, for anything that reads router state (an unsaved
 * changes blocker, a link) without belonging to a real screen.
 */
export function renderInRouter(ui: ReactElement) {
    const root = createRootRoute({ component: Outlet });
    const index = createRoute({ getParentRoute: () => root, path: '/', component: () => ui });
    const router = createRouter({
        routeTree: root.addChildren([index]),
        history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    const queryClient = testQueryClient();
    const result = render(
        <ThemeProvider>
            <QueryClientProvider client={queryClient}>
                <TooltipProvider delayDuration={0}>
                    <RouterProvider router={router} />
                </TooltipProvider>
            </QueryClientProvider>
        </ThemeProvider>,
    );
    return { ...result, router, queryClient };
}
