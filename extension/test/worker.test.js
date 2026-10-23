// @ts-check
import { describe, expect, it, vi } from 'vitest';
import { isBackgroundWorker, needsReload, startWorker } from '../worker.js';
import { batch, fakeBridge } from './fakes.js';

describe('isBackgroundWorker', () => {
    it('is true only when the server plugin set the flag', () => {
        expect(isBackgroundWorker({})).toBe(false);
        expect(isBackgroundWorker({ __WHATSCHAT_WORKER__: true })).toBe(true);
        expect(isBackgroundWorker({ __WHATSCHAT_WORKER__: 'yes' })).toBe(false);
    });
});

describe('needsReload', () => {
    const base = { loadedAt: 1_000, lastActivityAt: 1_000, staleAt: 0, now: 2_000, idleReloadMs: 60_000 };

    it('does not reload a fresh, recently active page', () => {
        expect(needsReload(base)).toBe(false);
    });

    it('reloads after a tab reported a change', () => {
        expect(needsReload({ ...base, staleAt: 1_500 })).toBe(true);
        expect(needsReload({ ...base, staleAt: 900 })).toBe(false);
    });

    it('reloads after a quiet spell, measured from the last reply', () => {
        expect(needsReload({ ...base, now: 62_000 })).toBe(true);
        expect(needsReload({ ...base, now: 62_000, lastActivityAt: 30_000 })).toBe(false);
        expect(needsReload({ ...base, now: 10_000_000, idleReloadMs: 0 })).toBe(false);
    });
});

describe('startWorker', () => {
    function setup() {
        /** @type {import('../api-client.js').StreamHandlers} */
        let handlers = {};
        const api = {
            getConfig: vi.fn(() => Promise.resolve({ background: { idleReloadMs: 60_000 } })),
            listen: vi.fn((/** @type {import('../api-client.js').StreamHandlers} */ h) => {
                handlers = h;
                return () => undefined;
            }),
            claim: vi.fn((/** @type {string} */ id) => Promise.resolve({ ok: true, batch: batch({ id }) })),
            reply: vi.fn(() => Promise.resolve({ ok: true, bubbles: 1 })),
            fail: vi.fn(() => Promise.resolve({ ok: true })),
        };
        const { bridge, log } = fakeBridge();
        const reload = vi.fn();
        let time = 1_000;
        /** @type {Record<string, unknown>} */
        const scope = {};
        const processor = startWorker({ api: /** @type {any} */ (api), bridge, reload, now: () => time, scope });
        return {
            api,
            log,
            reload,
            scope,
            processor,
            handlers: () => handlers,
            advance: (/** @type {number} */ ms) => {
                time += ms;
            },
        };
    }

    it('marks itself ready once its event stream is open', () => {
        const w = setup();
        expect(w.scope['__WHATSCHAT_WORKER_READY__']).toBeUndefined();
        w.handlers().connection?.('open');
        expect(w.scope['__WHATSCHAT_WORKER_READY__']).toBe(true);
    });

    it('replies without going back to a previous chat, re-reading the chat first', async () => {
        const w = setup();
        w.handlers().batch?.(batch());
        await w.processor.whenIdle();
        expect(w.api.reply).toHaveBeenCalledOnce();
        expect(w.log).toContain('reloadOpenChat');
        expect(w.log.some((l) => l.startsWith('restoreChat'))).toBe(false);
    });

    it('reloads instead of claiming when a tab reported a change', async () => {
        const w = setup();
        w.advance(10);
        w.handlers().stale?.({ at: 1_005 });
        w.handlers().batch?.(batch());
        await w.processor.whenIdle();
        expect(w.reload).toHaveBeenCalledOnce();
        expect(w.api.claim).not.toHaveBeenCalled();
    });

    it('reloads after being idle for longer than configured', async () => {
        const w = setup();
        await Promise.resolve();
        w.advance(61_000);
        w.handlers().batch?.(batch());
        await w.processor.whenIdle();
        expect(w.reload).toHaveBeenCalledOnce();
    });
});
