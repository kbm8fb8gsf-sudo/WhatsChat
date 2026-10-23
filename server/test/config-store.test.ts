import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config/schema.js';
import { ConfigStore } from '../src/config/store.js';
import { silentLogger } from '../src/util/logger.js';

let dir: string;
let file: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'whatschat-config-'));
    file = path.join(dir, 'nested', 'config.json');
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('ConfigStore', () => {
    it('uses defaults when the file does not exist, without creating it', async () => {
        const store = new ConfigStore(file, silentLogger);
        expect(await store.load()).toEqual(defaultConfig());
        await expect(stat(file)).rejects.toThrow();
    });

    it('saves atomically, creating directories, and reloads the same config', async () => {
        const store = new ConfigStore(file, silentLogger);
        await store.load();
        const result = await store.save({ enabled: true, contacts: [{ id: '+447700900123', characterAvatar: 'A.png' }] });
        expect(result.ok).toBe(true);

        const reloaded = new ConfigStore(file, silentLogger);
        const config = await reloaded.load();
        expect(config.enabled).toBe(true);
        expect(config.contacts[0]?.id).toBe('+447700900123');

        // No temp files left behind.
        expect(await readdir(path.dirname(file))).toEqual(['config.json']);
        if (process.platform !== 'win32') {
            expect((await stat(file)).mode & 0o777).toBe(0o600);
        }
    });

    it('rejects invalid input without touching memory or disk', async () => {
        const store = new ConfigStore(file, silentLogger);
        await store.load();
        const result = await store.save({ enabled: 'nope' });
        expect(result.ok).toBe(false);
        expect(store.get()).toEqual(defaultConfig());
        await expect(stat(file)).rejects.toThrow();
    });

    it('sets aside a corrupt file and falls back to defaults', async () => {
        const logger = { ...silentLogger, warn: vi.fn() };
        const store = new ConfigStore(file, logger);
        await store.save({ enabled: true });
        await writeFile(file, '{ not json', 'utf8');

        expect(await store.load()).toEqual(defaultConfig());
        expect(logger.warn).toHaveBeenCalledOnce();
        const files = await readdir(path.dirname(file));
        expect(files.some((f) => f.startsWith('config.json.invalid-'))).toBe(true);
        expect(files).not.toContain('config.json');
    });

    it('sets aside a file that fails validation', async () => {
        await store().save({});
        await writeFile(file, JSON.stringify({ enabled: 42 }), 'utf8');
        const fresh = new ConfigStore(file, silentLogger);
        expect(await fresh.load()).toEqual(defaultConfig());
        const files = await readdir(path.dirname(file));
        expect(files.some((f) => f.startsWith('config.json.invalid-'))).toBe(true);
    });

    it('serialises concurrent updates so none are lost', async () => {
        const s = store();
        await s.load();
        await Promise.all([
            s.update((draft) => { draft.enabled = true; }),
            s.update((draft) => { draft.inbound.quietMs = 1234; }),
            s.update((draft) => { draft.realistic.preset = 'busy'; }),
        ]);
        const onDisk = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        expect(onDisk).toMatchObject({ enabled: true, inbound: { quietMs: 1234 }, realistic: { preset: 'busy' } });
    });

    it('notifies listeners with the new and previous config', async () => {
        const s = store();
        await s.load();
        const listener = vi.fn();
        const unsubscribe = s.onChange(listener);
        await s.save({ enabled: true });
        expect(listener).toHaveBeenCalledWith(
            expect.objectContaining({ enabled: true }),
            expect.objectContaining({ enabled: false }),
        );
        unsubscribe();
        await s.save({ enabled: false });
        expect(listener).toHaveBeenCalledOnce();
    });
});

function store(): ConfigStore {
    return new ConfigStore(file, silentLogger);
}
