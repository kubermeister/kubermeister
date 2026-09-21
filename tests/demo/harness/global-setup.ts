import { ensureCluster } from './cluster';

export default async function globalSetup(): Promise<void> {
    await ensureCluster();
}
