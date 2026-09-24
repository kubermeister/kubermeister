import { z } from 'zod';

/** A kube-context entry from the loaded kubeconfig, plus whether it is the active one. */
export const kubeContextSchema = z.object({
    name: z.string(),
    cluster: z.string(),
    /**
     * The cluster entry's API server in `normalizeServer`'s form, which is what a link names the
     * cluster by. Absent when the entry is missing or its server is not an http or https URL.
     */
    server: z.string().optional(),
    user: z.string(),
    /** The context's default namespace, if the kubeconfig sets one. */
    namespace: z.string().optional(),
    current: z.boolean(),
    /**
     * Why this context cannot be used, when it names a cluster or user the kubeconfig does not
     * define. The library lists such a context and lets it be switched to, then fails every call.
     */
    problem: z.string().optional(),
});

export type KubeContext = z.infer<typeof kubeContextSchema>;
