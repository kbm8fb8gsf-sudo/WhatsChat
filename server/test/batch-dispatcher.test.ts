import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchDispatcher, type DispatcherOptions, type DropReason } from '../src/core/batch-dispatcher.js';
import { systemScheduler } from '../src/core/scheduler.js';
import type { InboundMessage } from '../src/transport/types.js';
import { silentLogger } from '../src/util/logger.js';
import { idSequence } from './helpers.js';

let offers: string[];
let drops: [string, DropReason][];
let options: DispatcherOptions;
let dispatcher: BatchDispatcher;

function message(contactId: string, text: string): InboundMessage {
    return {
        id: text,
        contactId,
        text,
        timestamp: Date.now(),
        replyTo: { transport: 'fake', id: `${contactId}-${text}` },
        ref: { chatId: contactId, messageId: text },
    };
}

beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    offers = [];
    drops = [];
    options = { leaseMs: 60_000, maxAgeMs: 3_600_000 };
    dispatcher = new BatchDispatcher(
        systemScheduler,
        () => options,
        {
            offer: (batch) => offers.push(`${batch.id}:${batch.messages.map((m) => m.text).join(',')}`),
            drop: (batch, reason) => drops.push([batch.id, reason]),
        },
        silentLogger,
        idSequence(),
    );
});

afterEach(() => {
    vi.useRealTimers();
});

describe('BatchDispatcher', () => {
    it('offers one batch at a time, in arrival order', () => {
        dispatcher.enqueue('a', [message('a', 'a1')]);
        dispatcher.enqueue('b', [message('b', 'b1')]);
        expect(offers).toEqual(['batch-1:a1']);
        expect(dispatcher.claim('batch-1', 'tab').ok).toBe(true);
        dispatcher.release('batch-1', 'tab', 'done');
        expect(offers).toEqual(['batch-1:a1', 'batch-2:b1']);
        expect(dispatcher.size).toBe(1);
    });

    it('merges messages into an unclaimed batch and re-offers it', () => {
        dispatcher.enqueue('a', [message('a', 'a1')]);
        dispatcher.enqueue('a', [message('a', 'a2')]);
        expect(offers).toEqual(['batch-1:a1', 'batch-1:a1,a2']);
        const claim = dispatcher.claim('batch-1', 'tab');
        expect(claim.ok && claim.batch.replyTo.id).toBe('a-a2');
    });

    it('merges into a queued batch without re-offering', () => {
        dispatcher.enqueue('a', [message('a', 'a1')]);
        dispatcher.enqueue('b', [message('b', 'b1')]);
        dispatcher.enqueue('b', [message('b', 'b2')]);
        expect(offers).toEqual(['batch-1:a1']);
        dispatcher.claim('batch-1', 'tab');
        dispatcher.release('batch-1', 'tab', 'done');
        expect(offers.at(-1)).toBe('batch-2:b1,b2');
    });

    it('starts a new batch for messages that arrive after the claim', () => {
        dispatcher.enqueue('a', [message('a', 'a1')]);
        dispatcher.claim('batch-1', 'tab');
        dispatcher.enqueue('a', [message('a', 'a2')]);
        expect(offers).toEqual(['batch-1:a1']);
        dispatcher.release('batch-1', 'tab', 'done');
        expect(offers).toEqual(['batch-1:a1', 'batch-2:a2']);
    });

    it('gives the batch to the first claimant only, and lets it renew', () => {
        dispatcher.enqueue('a', [message('a', 'a1')]);
        expect(dispatcher.claim('batch-1', 'tab1')).toMatchObject({ ok: true, first: true });
        expect(dispatcher.claim('batch-1', 'tab2')).toEqual({ ok: false, reason: 'claimed-by-other' });
        expect(dispatcher.claim('batch-1', 'tab1')).toMatchObject({ ok: true, first: false });
        expect(dispatcher.claim('nope', 'tab1')).toEqual({ ok: false, reason: 'unknown-batch' });
    });

    it('re-offers once when the lease expires, then drops', () => {
        dispatcher.enqueue('a', [message('a', 'a1')]);
        dispatcher.enqueue('b', [message('b', 'b1')]);
        dispatcher.claim('batch-1', 'tab');
        vi.advanceTimersByTime(59_999);
        expect(offers.length).toBe(1);
        vi.advanceTimersByTime(1);
        expect(offers).toEqual(['batch-1:a1', 'batch-1:a1']);
        dispatcher.claim('batch-1', 'tab2');
        vi.advanceTimersByTime(60_000);
        expect(drops).toEqual([['batch-1', 'lease-expired']]);
        expect(offers.at(-1)).toBe('batch-2:b1');
    });

    it('renewing the claim keeps the lease alive', () => {
        dispatcher.enqueue('a', [message('a', 'a1')]);
        dispatcher.claim('batch-1', 'tab');
        for (let i = 0; i < 5; i++) {
            vi.advanceTimersByTime(50_000);
            dispatcher.claim('batch-1', 'tab');
        }
        expect(offers.length).toBe(1);
        expect(drops).toEqual([]);
    });

    it('re-offers when the claiming tab goes away', () => {
        dispatcher.enqueue('a', [message('a', 'a1')]);
        dispatcher.claim('batch-1', 'tab');
        dispatcher.clientGone('other');
        expect(offers.length).toBe(1);
        dispatcher.clientGone('tab');
        expect(offers.length).toBe(2);
        expect(dispatcher.pendingOffer()?.id).toBe('batch-1');
    });

    it('only the claimant can release, and failing reports a drop', () => {
        dispatcher.enqueue('a', [message('a', 'a1')]);
        dispatcher.claim('batch-1', 'tab');
        expect(dispatcher.release('batch-1', 'intruder', 'done')).toEqual({ ok: false, reason: 'not-claimed' });
        expect(dispatcher.release('batch-1', 'tab', 'failed').ok).toBe(true);
        expect(drops).toEqual([['batch-1', 'failed']]);
    });

    it('drops stale batches instead of offering them', () => {
        dispatcher.enqueue('a', [message('a', 'a1')]);
        dispatcher.enqueue('b', [message('b', 'b1')]);
        vi.advanceTimersByTime(options.maxAgeMs + 1);
        expect(dispatcher.pendingOffer()).toBeUndefined();
        expect(drops).toEqual([
            ['batch-1', 'stale'],
            ['batch-2', 'stale'],
        ]);
    });

    it('cancels a contact or everything', () => {
        dispatcher.enqueue('a', [message('a', 'a1')]);
        dispatcher.enqueue('b', [message('b', 'b1')]);
        dispatcher.enqueue('c', [message('c', 'c1')]);
        dispatcher.cancelContact('a');
        expect(drops).toEqual([['batch-1', 'cancelled']]);
        expect(offers.at(-1)).toBe('batch-2:b1');
        dispatcher.cancelAll();
        expect(drops.map((d) => d[0])).toEqual(['batch-1', 'batch-2', 'batch-3']);
        expect(dispatcher.size).toBe(0);
    });

    it('dispose clears timers and ignores new work', () => {
        dispatcher.enqueue('a', [message('a', 'a1')]);
        dispatcher.claim('batch-1', 'tab');
        dispatcher.dispose();
        expect(vi.getTimerCount()).toBe(0);
        expect(dispatcher.enqueue('a', [message('a', 'a2')])).toBeNull();
        expect(offers.length).toBe(1);
    });
});
