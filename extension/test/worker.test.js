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
    /** @param {{ connected?: boolean, stored?: Record<string, string> }} [options] */
    function setup(options = {}) {
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
            reportHealth: vi.fn(() => Promise.resolve({ ok: true })),
        };
        let connected = options.connected ?? true;
        const { bridge, log } = fakeBridge({
            apiStatus: () => ({ connected, api: 'openai' }),
            waitForApi: vi.fn(() => Promise.resolve(connected)),
        });
        /** @type {Map<string, string>} */
        const stored = new Map(Object.entries(options.stored ?? {}));
        const storage = { getItem: (/** @type {string} */ k) => stored.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => void stored.set(k, v) };
        const reload = vi.fn();
        let time = 1_000;
        /** @type {Record<string, unknown>} */
        const scope = {};
        const processor = startWorker({ api: /** @type {any} */ (api), bridge, reload, now: () => time, scope, storage });
        return {
            api,
            bridge,
            stored,
            setConnected: (/** @type {boolean} */ value) => {
                connected = value;
            },
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

    it('marks itself ready and reports its AI connection once its event stream is open', () => {
        const w = setup();
        expect(w.scope['__WHATSCHAT_WORKER_READY__']).toBeUndefined();
        w.handlers().connection?.('open');
        expect(w.scope['__WHATSCHAT_WORKER_READY__']).toBe(true);
        expect(w.api.reportHealth).toHaveBeenCalledWith({ connected: true, api: 'openai' });
    });

    it('reports again when the AI connection changes', () => {
        const w = setup();
        const onChange = /** @type {import('vitest').Mock} */ (w.bridge.onApiStatusChange).mock.calls[0]?.[0];
        w.setConnected(false);
        onChange();
        expect(w.api.reportHealth).toHaveBeenLastCalledWith({ connected: false, api: 'openai' });
    });

    it('reloads to reconnect when the AI is not connected, at most once a minute', async () => {
        const w = setup({ connected: false });
        w.handlers().batch?.(batch({ id: 'a' }));
        await w.processor.whenIdle();
        expect(w.reload).toHaveBeenCalledOnce();
        expect(w.api.claim).not.toHaveBeenCalled();
        expect(w.stored.get('whatschat.reconnectReloadAt')).toBe('1000');
    });

    it('tries anyway if it reloaded to reconnect very recently, so the failure gets reported', async () => {
        const w = setup({ connected: false, stored: { 'whatschat.reconnectReloadAt': '990' } });
        w.handlers().batch?.(batch());
        await w.processor.whenIdle();
        expect(w.reload).not.toHaveBeenCalled();
        expect(w.api.claim).toHaveBeenCalledOnce();
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
