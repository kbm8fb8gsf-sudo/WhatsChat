import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as plugin from '../src/index.js';

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'whatschat-plugin-'));
    process.env['WHATSCHAT_DATA_DIR'] = dir;
});

afterEach(async () => {
    await plugin.exit();
    delete process.env['WHATSCHAT_DATA_DIR'];
    await rm(dir, { recursive: true, force: true });
});

describe('SillyTavern plugin contract', () => {
    it('exports info with the fields the loader requires', () => {
        expect(typeof plugin.info.id).toBe('string');
        expect(typeof plugin.info.name).toBe('string');
        expect(typeof plugin.info.description).toBe('string');
        // Same rule as SillyTavern's isValidPluginID.
        expect(plugin.info.id).toMatch(/^[a-z0-9_-]+$/);
    });

    it('registers routes during init and serves /status under the plugin prefix, without connecting', async () => {
        const router = express.Router();
        await plugin.init(router);
        expect(router.stack.length).toBeGreaterThan(0);

        const app = express();
        app.use(express.json());
        app.use(`/api/plugins/${plugin.info.id}`, router);
        const server = app.listen(0);
        try {
            const { port } = server.address() as AddressInfo;
            const res = await fetch(`http://127.0.0.1:${String(port)}/api/plugins/whatschat/status`);
            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({
                enabled: false,
                transportKind: 'whatsapp',
                transport: { state: 'disabled' },
            });
        } finally {
            server.close();
        }
    });

    it('exit resolves when called twice, or before init', async () => {
        await expect(plugin.exit()).resolves.toBeUndefined();
        await plugin.init(express.Router());
        await expect(plugin.exit()).resolves.toBeUndefined();
        await expect(plugin.exit()).resolves.toBeUndefined();
    });
});
