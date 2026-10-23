import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import * as plugin from '../src/index.js';

describe('SillyTavern plugin contract', () => {
    it('exports info with the fields the loader requires', () => {
        expect(typeof plugin.info.id).toBe('string');
        expect(typeof plugin.info.name).toBe('string');
        expect(typeof plugin.info.description).toBe('string');
        // Same rule as SillyTavern's isValidPluginID.
        expect(plugin.info.id).toMatch(/^[a-z0-9_-]+$/);
    });

    it('registers routes during init and serves /status under the plugin prefix', async () => {
        const router = express.Router();
        await plugin.init(router);
        expect(router.stack.length).toBeGreaterThan(0);

        const app = express();
        app.use(`/api/plugins/${plugin.info.id}`, router);
        const server = app.listen(0);
        try {
            const { port } = server.address() as AddressInfo;
            const res = await fetch(`http://127.0.0.1:${port}/api/plugins/whatschat/status`);
            expect(res.status).toBe(200);
        } finally {
            server.close();
            await plugin.exit();
        }
    });

    it('exit resolves when called twice', async () => {
        await expect(plugin.exit()).resolves.toBeUndefined();
        await expect(plugin.exit()).resolves.toBeUndefined();
    });
});
