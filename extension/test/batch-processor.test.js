// @ts-check
import { describe, expect, it, vi } from 'vitest';
import { BatchProcessor } from '../batch-processor.js';
import { batch, fakeBridge } from './fakes.js';

/** @param {Partial<{ claim: any, reply: any, fail: any }>} [overrides] */
function fakeApi(overrides = {}) {
    return {
        claim: vi.fn((/** @type {string} */ id) => Promise.resolve({ ok: true, batch: batch({ id }) })),
        reply: vi.fn(() => Promise.resolve({ ok: true, bubbles: 1 })),
        fail: vi.fn(() => Promise.resolve({ ok: true })),
        ...overrides,
    };
}

/**
 * @param {ReturnType<typeof fakeApi>} api
 * @param {import('../st-bridge.js').Bridge} bridge
 * @param {boolean} [restore]
 */
function processor(api, bridge, restore = true) {
    return new BatchProcessor({
        api: /** @type {any} */ (api),
        bridge,
        settings: () => ({ restorePreviousChat: restore }),
        setIntervalImpl: () => 0,
        clearIntervalImpl: () => undefined,
    });
}

describe('BatchProcessor', () => {
    it('claims, opens the chat, generates with the note, replies and restores', async () => {
        const api = fakeApi();
        const { bridge, log } = fakeBridge();
        const p = processor(api, bridge);
        p.offer(batch());
        await p.whenIdle();

        expect(api.claim).toHaveBeenCalledWith('batch-1');
        expect(log).toEqual([
            'waitUntilIdle',
            'openChat Seraphina.png Seraphina - WhatsApp',
            'addUserMessage hey\nyou there?',
            'setNote You are texting.',
            'generateReply',
            'clearNote',
            'restoreChat Other - chat',
        ]);
        expect(api.reply).toHaveBeenCalledWith('batch-1', {
            text: 'Seraphina: hello!',
            chatFile: 'Seraphina - WhatsApp',
            characterName: 'Seraphina',
            userName: 'Lewis',
        });
    });

    it('reports the chat it created for a contact without one', async () => {
        const api = fakeApi({
            claim: vi.fn(() => Promise.resolve({ ok: true, batch: batch({ chatFile: null }) })),
        });
        const { bridge } = fakeBridge();
        const p = processor(api, bridge);
        p.offer(batch({ chatFile: null }));
        await p.whenIdle();
        expect(api.reply).toHaveBeenCalledWith('batch-1', expect.objectContaining({ chatFile: 'Seraphina - new' }));
    });

    it('skips the note when there is none', async () => {
        const api = fakeApi({ claim: vi.fn(() => Promise.resolve({ ok: true, batch: batch({ note: null }) })) });
        const { bridge, log } = fakeBridge();
        const p = processor(api, bridge);
        p.offer(batch());
        await p.whenIdle();
        expect(log.some((l) => l.startsWith('setNote'))).toBe(false);
        expect(log).toContain('clearNote');
    });

    it('does nothing when another tab claimed the batch', async () => {
        const api = fakeApi({ claim: vi.fn(() => Promise.resolve({ ok: false, reason: 'claimed-by-other' })) });
        const { bridge, log } = fakeBridge();
        const p = processor(api, bridge);
        p.offer(batch());
        await p.whenIdle();
        expect(log).toEqual([]);
        expect(api.reply).not.toHaveBeenCalled();
    });

    it('fails the batch, clears the note and restores the chat when generation fails', async () => {
        const api = fakeApi();
        const { bridge, log } = fakeBridge({
            generateReply: vi.fn(() => Promise.reject(new Error('No API connected'))),
        });
        const p = processor(api, bridge);
        p.offer(batch());
        await p.whenIdle();
        expect(api.fail).toHaveBeenCalledWith('batch-1', 'No API connected');
        expect(bridge.clearNote).toHaveBeenCalled();
        expect(log.at(-1)).toBe('restoreChat Other - chat');
        expect(bridge.notify).toHaveBeenCalledWith("Couldn't reply to Alice: No API connected", 'error');
    });

    it('warns when the server would not send the reply', async () => {
        const api = fakeApi({ reply: vi.fn(() => Promise.resolve({ ok: false, reason: 'empty-reply' })) });
        const { bridge } = fakeBridge();
        const p = processor(api, bridge);
        p.offer(batch());
        await p.whenIdle();
        expect(bridge.notify).toHaveBeenCalledWith(expect.stringContaining('empty'), 'warning');
        expect(api.fail).not.toHaveBeenCalled();
    });

    it('leaves the chat open when restoring is turned off', async () => {
        const api = fakeApi();
        const { bridge } = fakeBridge();
        const p = processor(api, bridge, false);
        p.offer(batch());
        await p.whenIdle();
        expect(bridge.restoreChat).not.toHaveBeenCalled();
    });

    it('handles batches one at a time, in order, ignoring repeats and dropped ones', async () => {
        const api = fakeApi();
        const { bridge, log } = fakeBridge();
        const p = processor(api, bridge);
        p.offer(batch({ id: 'a', text: 'first' }));
        p.offer(batch({ id: 'b', text: 'second' }));
        p.offer(batch({ id: 'c', text: 'third' }));
        p.offer(batch({ id: 'b', text: 'second, updated' }));
        p.dropped('c');
        await p.whenIdle();
        expect(api.claim.mock.calls.map((/** @type {unknown[]} */ c) => c[0])).toEqual(['a', 'b']);
        expect(log.filter((l) => l.startsWith('generateReply')).length).toBe(2);
    });

    it('renews its claim while working and stops afterwards', async () => {
        const api = fakeApi();
        const { bridge } = fakeBridge();
        /** @type {(() => void) | null} */
        let renew = null;
        const cleared = vi.fn();
        const p = new BatchProcessor({
            api: /** @type {any} */ (api),
            bridge,
            settings: () => ({ restorePreviousChat: true }),
            setIntervalImpl: (callback) => {
                renew = callback;
                return 42;
            },
            clearIntervalImpl: cleared,
        });
        p.offer(batch());
        await p.whenIdle();
        expect(renew).not.toBeNull();
        /** @type {() => void} */ (/** @type {unknown} */ (renew))();
        expect(api.claim).toHaveBeenCalledTimes(2);
        expect(cleared).toHaveBeenCalledWith(42);
    });
});
