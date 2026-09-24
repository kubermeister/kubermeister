import { z } from 'zod';
import type { AllowedSubscription } from './ipc-channels.js';
import { updateStateSchema } from './ipc.js';

/**
 * Main-to-renderer push channels. Each id names a `sub.<id>` event the preload lets the renderer
 * listen to; the payload schema is validated in main before sending. Kept separate from the
 * request channels so the preload allowlist stays a plain string array.
 */
export const subSchemas = {
    'update.state': updateStateSchema,
    /** The application menu's Settings item; the renderer routes to the settings screen. */
    'open-settings': z.object({}),
    /**
     * A menu item for a key the renderer handles itself, clicked: the click and the key then take
     * one path, the renderer's dispatcher.
     */
    shortcut: z.object({ id: z.enum(['refresh', 'cheatSheet']) }),
    /**
     * The settings file changed on disk and main has taken the change in. `reconnected` says the
     * connection was remade with it, so every cluster read the renderer holds is from before.
     */
    'settings.changed': z.object({ reconnected: z.boolean() }),
    /**
     * The OS handed the app a `kubermeister://` link. The push says only that one is waiting: the
     * renderer takes it through `deepLink.take`, which is also how it reads one that arrived before
     * it mounted, so there is one way in for a link and it is read once.
     */
    'deep-link': z.object({}),
} as const satisfies Record<AllowedSubscription, z.ZodType>;

export type SubChannel = AllowedSubscription;
export type SubPayload<C extends SubChannel> = z.infer<(typeof subSchemas)[C]>;
