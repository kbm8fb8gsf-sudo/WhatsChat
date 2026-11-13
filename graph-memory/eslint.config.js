import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig(
    { ignores: ['node_modules/', 'data/', 'coverage/'] },
    js.configs.recommended,
    {
        files: ['server/**/*.js', 'vitest.config.js', 'eslint.config.js'],
        languageOptions: { globals: globals.node },
    },
    {
        files: ['extension/**/*.js'],
        languageOptions: {
            globals: { ...globals.browser, SillyTavern: 'readonly' },
        },
    },
    {
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
        },
    },
);
