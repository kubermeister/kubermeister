import { createHashHistory, createRouter } from '@tanstack/react-router';
import { routeTree, type FileRouteTypes } from '@/routeTree.gen';
import { objectRemountDeps } from './remount';

/** Every registered absolute route path; navigation config is typed against it. */
export type RoutePath = FileRouteTypes['to'];

// Hash history: the packaged renderer is a file:// document, and hash changes never trigger the
// main process's top-frame navigation guard.
export const router = createRouter({
    routeTree,
    history: createHashHistory(),
    defaultRemountDeps: objectRemountDeps,
});

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router;
    }
}
