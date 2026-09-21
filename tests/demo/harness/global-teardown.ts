import { stopCluster } from './cluster';

export default async function globalTeardown(): Promise<void> {
    await stopCluster();
}
