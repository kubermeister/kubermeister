import { z } from 'zod';

/**
 * Whether the `helm` a chart is rendered with was found. Helm is the one program outside the app it
 * runs, and it runs only to render: without it a chart cannot be installed, and nothing else in the
 * app changes, so a missing Helm is a state the screens that need it describe rather than a failure.
 */
export const helmStatusSchema = z.discriminatedUnion('found', [
    z.object({ found: z.literal(true), path: z.string(), version: z.string() }),
    z.object({ found: z.literal(false) }),
]);

export type HelmStatus = z.infer<typeof helmStatusSchema>;

/** Where a screen that needs Helm sends somebody who does not have it. */
export const HELM_INSTALL_URL = 'https://helm.sh/docs/intro/install/';
