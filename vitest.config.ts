import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const alias = { '@': resolve(__dirname, 'src/renderer') };

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: 'node',
                    environment: 'node',
                    include: ['tests/unit/**/*.test.ts'],
                    exclude: ['tests/unit/renderer/**'],
                    setupFiles: ['tests/setup.ts'],
                },
                resolve: { alias },
            },
            {
                test: {
                    name: 'renderer',
                    environment: 'jsdom',
                    include: ['tests/unit/renderer/**/*.test.{ts,tsx}'],
                    setupFiles: ['tests/setup.ts', 'tests/setup-renderer.ts'],
                },
                resolve: { alias },
            },
        ],
        coverage: {
            provider: 'v8',
            // Unit-testable code. Excluded: process bootstrap (app lifecycle, the preload bridge,
            // the React entry), generated route code, shadcn primitives, and route files, which are
            // thin compositions covered end to end. Window creation is not bootstrap: it holds the
            // renderer hardening and is unit tested.
            include: ['src/main/**/*.ts', 'src/shared/**/*.ts', 'src/renderer/**/*.{ts,tsx}'],
            exclude: [
                'src/main/index.ts',
                'src/renderer/main.tsx',
                'src/renderer/app.tsx',
                'src/renderer/lib/router.ts',
                'src/renderer/routeTree.gen.ts',
                'src/renderer/routes/**',
                'src/renderer/components/ui/**',
                'src/renderer/env.d.ts',
            ],
            // Ratchet: raise these as coverage grows, never lower them.
            thresholds: {
                statements: 96,
                branches: 90,
                functions: 96,
                lines: 97,
            },
            reporter: ['text', 'lcov'],
        },
    },
});
