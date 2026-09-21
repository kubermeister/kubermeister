import { defineConfig } from '@playwright/test';

/**
 * The screenshot run: the same built app the end-to-end suite drives, against its own demo cluster
 * (`tests/demo/harness/cluster.ts`), photographed once per theme. It is not a test suite — nothing
 * here asserts that the app is correct — so it has its own config rather than a project inside
 * `playwright.config.ts`, and `npm run test:e2e` never starts the demo cluster.
 *
 * Run: npm run build && npm run screenshots
 */
export default defineConfig({
    testDir: 'tests/demo/shots',
    globalSetup: './tests/demo/harness/global-setup.ts',
    globalTeardown: './tests/demo/harness/global-teardown.ts',
    // The dashboard shot waits out a soak so the sampler has a series to draw.
    timeout: 300_000,
    retries: 0,
    // One app at a time: two would fight over the port a forward listens on and over the window.
    workers: 1,
    // The theme each project shoots; the shots read it from the project name.
    projects: [{ name: 'dark' }, { name: 'light' }],
    reporter: [['list']],
    outputDir: 'test-results/demo',
});
