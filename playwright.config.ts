import { defineConfig } from '@playwright/test';

// The specs are split in two projects of about equal length so CI can run each on its own runner
// and cluster at once (the e2e matrix in ci.yml). A file belongs to one project whole, since specs
// within a file run in order and some build on the one before; a new file lands in `actions`.
const APP_SPECS = ['**/app.test.ts', '**/deep-links.test.ts'];

// End-to-end suite: launches the built app (npm run build first) against a disposable k3s cluster
// started in global setup. One worker: the specs share that cluster and the app owns a window.
export default defineConfig({
    testDir: 'tests/e2e/specs',
    globalSetup: './tests/e2e/harness/global-setup.ts',
    globalTeardown: './tests/e2e/harness/global-teardown.ts',
    timeout: 120_000,
    retries: 0,
    workers: 1,
    reporter: [['list']],
    // A failure on CI cannot be rerun to look at, so it keeps its trace; CI uploads test-results/.
    // The harness applies this itself, since Playwright's fixtures never see an Electron context.
    use: { trace: 'retain-on-failure' },
    projects: [
        { name: 'app', testMatch: APP_SPECS },
        { name: 'actions', testIgnore: APP_SPECS },
    ],
});
