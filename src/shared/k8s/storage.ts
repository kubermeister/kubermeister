import { z } from 'zod';

const pairs = z.array(z.tuple([z.string(), z.string()]));

export const volumeStatusSchema = z.enum(['Bound', 'Available', 'Released', 'Failed', 'Pending', 'Unknown']);
export const claimStatusSchema = z.enum(['Bound', 'Pending', 'Lost', 'Unknown']);
export const snapshotReadySchema = z.enum(['Ready', 'Pending', 'Failed']);

export const volumeSchema = z.object({
    name: z.string(),
    capacity: z.string(),
    /** Access modes as their short forms (RWO, ROX, RWX, RWOP), comma-joined. */
    accessModes: z.string(),
    reclaimPolicy: z.string(),
    status: volumeStatusSchema,
    /** The bound claim as `namespace/name`, or an em-dash. */
    claim: z.string(),
    storageClass: z.string(),
    age: z.string(),
});
export const volumeDetailSchema = volumeSchema.extend({ labels: pairs, annotations: pairs });

export const claimSchema = z.object({
    name: z.string(),
    namespace: z.string(),
    status: claimStatusSchema,
    volume: z.string(),
    capacity: z.string(),
    accessModes: z.string(),
    storageClass: z.string(),
    age: z.string(),
});
export const claimDetailSchema = claimSchema.extend({ labels: pairs, annotations: pairs });

export const storageClassSchema = z.object({
    name: z.string(),
    provisioner: z.string(),
    reclaimPolicy: z.string(),
    volumeBinding: z.string(),
    isDefault: z.boolean(),
    age: z.string(),
});
export const storageClassDetailSchema = storageClassSchema.extend({ labels: pairs, annotations: pairs });

export const snapshotSchema = z.object({
    name: z.string(),
    namespace: z.string(),
    /** Source claim as `pvc/name`, or an em-dash. */
    sourcePvc: z.string(),
    restoreSize: z.string(),
    ready: snapshotReadySchema,
    age: z.string(),
});
export const snapshotDetailSchema = snapshotSchema.extend({ labels: pairs, annotations: pairs });

export type VolumeStatus = z.infer<typeof volumeStatusSchema>;
export type ClaimStatus = z.infer<typeof claimStatusSchema>;
export type SnapshotReady = z.infer<typeof snapshotReadySchema>;
export type Volume = z.infer<typeof volumeSchema>;
export type VolumeDetail = z.infer<typeof volumeDetailSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type ClaimDetail = z.infer<typeof claimDetailSchema>;
export type StorageClass = z.infer<typeof storageClassSchema>;
export type StorageClassDetail = z.infer<typeof storageClassDetailSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type SnapshotDetail = z.infer<typeof snapshotDetailSchema>;
