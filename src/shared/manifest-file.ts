import { z } from 'zod';

/**
 * A manifest read from disk by the main process. The renderer gets the text and the file's name,
 * which is what it puts in front of the user; the path travels with it only so a failure and the
 * editor can say which file was opened.
 */
export const manifestFileSchema = z.object({
    path: z.string().min(1),
    name: z.string().min(1),
    text: z.string(),
});

/**
 * Input to the read behind a drop. It is not in `IPC_CHANNELS`, so `km.invoke` will not forward it:
 * the only caller is the preload, which fills the path in from the dropped file itself.
 */
export const manifestReadInputSchema = z.object({ path: z.string().min(1) });

export type ManifestFile = z.infer<typeof manifestFileSchema>;
