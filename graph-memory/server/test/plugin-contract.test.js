import express from 'express';
import { describe, expect, it } from 'vitest';
import * as plugin from '../index.js';
import { silentLogger } from '../util.js';
import { tempDir } from './helpers.js';

describe('SillyTavern plugin contract', () => {
    it('exports info with a valid id, init and exit', () => {
        expect(plugin.info.id).toMatch(/^[a-z0-9_-]+$/);
        expect(typeof plugin.init).toBe('function');
        expect(typeof plugin.exit).toBe('function');
    });

    it('has routes on the router when init resolves (SillyTavern only mounts it then)', async () => {
        const router = express.Router();
        await plugin.init(router, { dataDir: await tempDir(), logger: silentLogger });
        expect(router.stack.length).toBeGreaterThan(5);
        await plugin.exit();
    });
});
