import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
    { ignores: ['dist/', 'node_modules/', 'data/', 'coverage/'] },
    js.configs.recommended,
    {
        files: ['server/**/*.ts', 'vitest.config.ts'],
        extends: [tseslint.configs.strictTypeChecked],
        languageOptions: {
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
            globals: globals.node,
        },
        rules: {
            '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        },
    },
    {
        files: ['extension/**/*.js'],
        languageOptions: {
            globals: { ...globals.browser, SillyTavern: 'readonly' },
        },
    },
    {
        files: ['eslint.config.js'],
        languageOptions: { globals: globals.node },
    },
);
