import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        // Plain Node scripts and root config files run under Node, not the browser.
        files: ['scripts/**/*.mjs', '*.config.{mjs,ts}', 'eslint.config.mjs'],
        languageOptions: { globals: globals.node },
    },
    {
        files: ['src/renderer/**/*.{ts,tsx}', 'tests/unit/renderer/**/*.{ts,tsx}'],
        plugins: { 'react-hooks': reactHooks },
        rules: { ...reactHooks.configs.recommended.rules },
    },
    {
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
        },
    },
    {
        // Only these two type-aware rules, scoped to app source: they catch unawaited promises and
        // async handlers passed where a sync callback is expected, the two IPC-heavy Electron bugs
        // that survive `strict`. The full type-checked preset fights the deliberate `unknown` at
        // the bridge boundary.
        files: ['src/**/*.{ts,tsx}'],
        languageOptions: {
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
        },
        rules: {
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
        },
    },
    {
        // The untyped `window.km` bridge is reachable only through the typed wrapper in lib/ipc.ts,
        // so a wrong channel name or payload shape fails at compile time, at one seam.
        files: ['src/renderer/**/*.{ts,tsx}'],
        ignores: ['src/renderer/lib/ipc.ts'],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: "MemberExpression[object.name='window'][property.name='km']",
                    message: 'Reach the main process through lib/ipc.ts, not window.km directly.',
                },
            ],
        },
    },
    {
        // The preload runs sandboxed, where `require` resolves only Electron built-ins. Any other
        // module in its import chain fails the bridge at load time and leaves `window.km`
        // undefined, so the preload imports exactly two things, and the channel list it imports
        // may import nothing at all. `scripts/check-preload.mjs` checks the built bundle as well.
        files: ['src/preload/**/*.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            regex: '^(?!electron$|\\.\\./shared/ipc-channels\\.js$)',
                            message: 'The preload imports only electron and ../shared/ipc-channels.js.',
                        },
                    ],
                },
            ],
        },
    },
    {
        files: ['src/shared/ipc-channels.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                { patterns: [{ regex: '.', message: 'ipc-channels.ts stays import-free: the preload requires it.' }] },
            ],
        },
    },
    prettier,
    { ignores: ['out/**', 'dist/**', 'release/**', 'coverage/**', 'src/renderer/routeTree.gen.ts'] },
);
