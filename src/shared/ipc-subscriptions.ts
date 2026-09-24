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
     * The settings file changed on disk and main has taken the change in. `reconnected` says the
     * connection was remade with it, so every cluster read the renderer holds is from before.
     */
    'settings.changed': z.object({ reconnected: z.boolean() }),
} as const satisfies Record<AllowedSubscription, z.ZodType>;

export type SubChannel = AllowedSubscription;
export type SubPayload<C extends SubChannel> = z.infer<(typeof subSchemas)[C]>;
