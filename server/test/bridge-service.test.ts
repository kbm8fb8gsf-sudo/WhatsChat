import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESETS } from '../src/config/presets.js';
import { DEFAULT_NOTE } from '../src/config/schema.js';
import { type BatchView, type BridgeEvent, BridgeService } from '../src/core/bridge-service.js';
import { planDelivery, planRead } from '../src/core/pacing.js';
import { createRng } from '../src/core/random.js';
import { systemScheduler } from '../src/core/scheduler.js';
import { FakeTransport } from '../src/transport/fake.js';
import { silentLogger } from '../src/util/logger.js';
import { idSequence, makeConfig, MemoryConfig } from './helpers.js';

const ALICE = '+447700900123';
const BOB = '+447700900456';
const SEED = 1234;

let transport: FakeTransport;
let config: MemoryConfig;
let service: BridgeService;
let events: BridgeEvent[];

function setup(overrides: Record<string, unknown> = {}): void {
    transport = new FakeTransport();
    config = new MemoryConfig(
        makeConfig({
            enabled: true,
            contacts: [
                { id: ALICE, label: 'Alice', characterAvatar: 'Seraphina.png', chatFile: 'Seraphina - WhatsApp' },
                { id: BOB, characterAvatar: 'Coding Sensei.png' },
            ],
            realistic: { preset: 'off' },
            inbound: { quietMs: 1_000, maxWaitMs: 10_000 },
            ...overrides,
        }),
    );
    service = new BridgeService({
        transport,
        config,
        scheduler: systemScheduler,
        rng: createRng(SEED),
        logger: silentLogger,
        newId: idSequence(),
        sendRetryDelaysMs: [1_000, 2_000],
    });
    events = [];
    service.onEvent((event) => events.push(event));
    service.start();
}

function offered(): BatchView[] {
    return events.flatMap((e) => (e.type === 'batch' ? [e.batch] : []));
}

function claimed(batchId: string, client = 'tab-1'): BatchView {
    const result = service.claim(batchId, client);
    if (!result.ok) throw new Error(`claim failed: ${result.reason}`);
    return result.batch;
}

beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(async () => {
    await service.close();
    vi.useRealTimers();
});

describe('BridgeService inbound', () => {
    it('connects on start when enabled', () => {
        setup();
        expect(transport.getStatus().state).toBe('connected');
    });

    it('stays disconnected when disabled', () => {
        setup({ enabled: false });
        expect(transport.getStatus().state).toBe('disabled');
    });

    it('batches an allowlisted contact’s quick messages and offers them', async () => {
        setup();
        transport.receive(ALICE, 'hey');
        await vi.advanceTimersByTimeAsync(500);
        transport.receive(ALICE, 'you there?', { pushName: 'Al' });
        expect(offered()).toEqual([]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(offered()).toEqual([
            {
                id: 'batch-1',
                contactId: ALICE,
                contactLabel: 'Alice',
                pushName: 'Al',
                characterAvatar: 'Seraphina.png',
                chatFile: 'Seraphina - WhatsApp',
                text: 'hey\nyou there?',
                note: null,
                messageCount: 2,
                receivedAt: 1_000_000,
            },
        ]);
        expect(service.pendingOffer()?.id).toBe('batch-1');
    });

    it('ignores contacts that are not on the allowlist', async () => {
        setup();
        transport.receive('+15551234567', 'spam?');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(offered()).toEqual([]);
        expect(transport.calls).toEqual([]);
    });

    it('neutralises macros and includes the note for realistic presets', async () => {
        setup({ realistic: { preset: 'natural' } });
        transport.receive(ALICE, 'tell me {{persona}}');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(offered()[0]).toMatchObject({ text: 'tell me {​{persona}}', note: DEFAULT_NOTE });
    });
});

describe('BridgeService replies with the off preset', () => {
    it('marks read on claim and sends the cleaned reply as one message', async () => {
        setup();
        transport.receive(ALICE, 'hi');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(transport.calls).toEqual([]);

        claimed('batch-1');
        await vi.advanceTimersByTimeAsync(0);
        expect(transport.calls).toEqual([{ kind: 'markRead', ids: ['msg-1'], at: 1_001_000 }]);

        const result = service.reply('batch-1', 'tab-1', {
            text: 'Seraphina: *smiles* Hello there!\n\nHow are you?',
            characterName: 'Seraphina',
        });
        expect(result).toEqual({ ok: true, bubbles: 1 });
        await vi.advanceTimersByTimeAsync(0);
        expect(transport.sent()).toEqual(['Hello there!\n\nHow are you?']);
        expect(transport.calls.some((c) => c.kind === 'setTyping')).toBe(false);
    });

    it('never marks anything read while no SillyTavern tab has claimed the batch', async () => {
        setup();
        transport.receive(ALICE, 'hi');
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(transport.calls).toEqual([]);
    });
});

describe('BridgeService realistic pacing', () => {
    it('follows the pacing plan: read, typing, then paced bubbles', async () => {
        setup({ realistic: { preset: 'natural' } });
        transport.receive(ALICE, 'how was your day?');
        await vi.advanceTimersByTimeAsync(1_000);
        const readyAt = Date.now();
        claimed('batch-1');
        await vi.advanceTimersByTimeAsync(3_000); // generation takes 3 s
        const replyAt = Date.now();
        service.reply('batch-1', 'tab-1', { text: 'pretty good!\n\nwent for a long walk by the river' });

        // Recompute the plan with the same seed to know the exact expected times.
        const rng = createRng(SEED);
        const read = planRead({ batchReadyAt: readyAt, claimedAt: readyAt, pacing: PRESETS.natural, rng });
        const steps = planDelivery({
            typingFrom: read.typingFrom,
            replyAt,
            bubbles: ['pretty good!', 'went for a long walk by the river'],
            pacing: PRESETS.natural,
            rng,
        });
        await vi.advanceTimersByTimeAsync(10 * 60_000);

        expect(transport.calls).toEqual([
            { kind: 'markRead', ids: ['msg-1'], at: read.readAt },
            { kind: 'setTyping', to: `${ALICE}@fake`, state: 'typing', at: read.typingFrom },
            { kind: 'sendText', to: `${ALICE}@fake`, text: 'pretty good!', at: steps[0]?.at },
            { kind: 'setTyping', to: `${ALICE}@fake`, state: 'typing', at: steps[1]?.at },
            { kind: 'sendText', to: `${ALICE}@fake`, text: 'went for a long walk by the river', at: steps[2]?.at },
        ]);
    });

    it('uses a contact’s own preset', async () => {
        setup({
            realistic: { preset: 'natural' },
            contacts: [{ id: ALICE, characterAvatar: 'A.png', preset: 'off' }],
        });
        transport.receive(ALICE, 'hi');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(offered()[0]?.note).toBeNull();
        claimed('batch-1');
        service.reply('batch-1', 'tab-1', { text: 'a\n\nb' });
        await vi.advanceTimersByTimeAsync(0);
        expect(transport.sent()).toEqual(['a\n\nb']);
    });
});

describe('BridgeService batch handling', () => {
    it('offers the next contact only after the current batch is answered', async () => {
        setup();
        transport.receive(ALICE, 'from alice');
        transport.receive(BOB, 'from bob');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(offered().map((b) => b.contactId)).toEqual([ALICE]);
        claimed('batch-1');
        service.reply('batch-1', 'tab-1', { text: 'hi alice' });
        expect(offered().map((b) => b.contactId)).toEqual([ALICE, BOB]);
    });

    it('lets only one tab claim a batch', async () => {
        setup();
        transport.receive(ALICE, 'hi');
        await vi.advanceTimersByTimeAsync(1_000);
        claimed('batch-1', 'tab-1');
        expect(service.claim('batch-1', 'tab-2')).toEqual({ ok: false, reason: 'claimed-by-other' });
        expect(service.reply('batch-1', 'tab-2', { text: 'x' })).toEqual({ ok: false, reason: 'not-claimed' });
    });

    it('drops a failed batch, stops typing, and moves on', async () => {
        setup({ realistic: { preset: 'quick' } });
        transport.receive(ALICE, 'hi');
        transport.receive(BOB, 'yo');
        await vi.advanceTimersByTimeAsync(1_000);
        claimed('batch-1');
        await vi.advanceTimersByTimeAsync(20_000); // read and typing have happened
        expect(service.fail('batch-1', 'tab-1', 'API offline')).toEqual({ ok: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(transport.calls.at(-1)).toMatchObject({ kind: 'setTyping', state: 'paused' });
        expect(events).toContainEqual({ type: 'batch-dropped', batchId: 'batch-1', contactId: ALICE, reason: 'failed' });
        expect(offered().at(-1)?.contactId).toBe(BOB);
    });

    it('cancels pending read and typing when a batch fails early', async () => {
        setup({ realistic: { preset: 'busy' } });
        transport.receive(ALICE, 'hi');
        await vi.advanceTimersByTimeAsync(1_000);
        claimed('batch-1');
        service.fail('batch-1', 'tab-1', 'boom');
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(transport.calls.map((c) => c.kind)).toEqual(['setTyping']);
        expect(transport.calls[0]).toMatchObject({ state: 'paused' });
    });

    it('saves the chat the extension created for a contact without one', async () => {
        setup();
        transport.receive(BOB, 'hi');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(claimed('batch-1').chatFile).toBeNull();
        service.reply('batch-1', 'tab-1', { text: 'hello', chatFile: 'Coding Sensei - 2026-10-23@15h00m00s' });
        await vi.advanceTimersByTimeAsync(0);
        expect(config.get().contacts[1]?.chatFile).toBe('Coding Sensei - 2026-10-23@15h00m00s');
    });

    it('does not overwrite a chat the contact already has', async () => {
        setup();
        transport.receive(ALICE, 'hi');
        await vi.advanceTimersByTimeAsync(1_000);
        claimed('batch-1');
        service.reply('batch-1', 'tab-1', { text: 'hello', chatFile: 'Something else' });
        await vi.advanceTimersByTimeAsync(0);
        expect(config.get().contacts[0]?.chatFile).toBe('Seraphina - WhatsApp');
    });

    it('reports a reply that was empty after cleaning', async () => {
        setup();
        transport.receive(ALICE, 'hi');
        await vi.advanceTimersByTimeAsync(1_000);
        claimed('batch-1');
        expect(service.reply('batch-1', 'tab-1', { text: '<think>hmm</think> *nods*' })).toEqual({
            ok: false,
            reason: 'empty-reply',
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(transport.sent()).toEqual([]);
    });

    it('re-offers a batch when the claiming tab disconnects', async () => {
        setup();
        transport.receive(ALICE, 'hi');
        await vi.advanceTimersByTimeAsync(1_000);
        claimed('batch-1', 'tab-1');
        service.clientGone('tab-1');
        expect(offered().length).toBe(2);
        expect(claimed('batch-1', 'tab-2').id).toBe('batch-1');
    });
});

describe('BridgeService sending', () => {
    it('retries a failed send', async () => {
        setup();
        transport.receive(ALICE, 'hi');
        await vi.advanceTimersByTimeAsync(1_000);
        claimed('batch-1');
        transport.failNextSends(new Error('blip'));
        service.reply('batch-1', 'tab-1', { text: 'hello' });
        await vi.advanceTimersByTimeAsync(999);
        expect(transport.sent()).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(transport.sent()).toEqual(['hello']);
    });

    it('drops the rest of a reply when a bubble keeps failing', async () => {
        setup({ realistic: { preset: 'quick' } });
        transport.receive(ALICE, 'hi');
        await vi.advanceTimersByTimeAsync(1_000);
        claimed('batch-1');
        transport.failNextSends(new Error('1'), new Error('2'), new Error('3'));
        service.reply('batch-1', 'tab-1', { text: 'one\n\ntwo' });
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(transport.sent()).toEqual([]);
    });
});

describe('BridgeService config changes', () => {
    it('disabling the bridge drops everything and disconnects', async () => {
        setup({ realistic: { preset: 'natural' } });
        transport.receive(ALICE, 'hi');
        await vi.advanceTimersByTimeAsync(1_000);
        claimed('batch-1');
        service.reply('batch-1', 'tab-1', { text: 'hello' });
        await service.disconnect();
        expect(transport.getStatus().state).toBe('disabled');
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(transport.sent()).toEqual([]);
        expect(service.status()).toMatchObject({ enabled: false, pendingBatches: 0, queuedTasks: 0 });
    });

    it('removing a contact cancels its batches', async () => {
        setup();
        transport.receive(ALICE, 'hi');
        transport.receive(BOB, 'yo');
        await vi.advanceTimersByTimeAsync(1_000);
        await config.update((draft) => {
            draft.contacts = draft.contacts.filter((c) => c.id !== ALICE);
        });
        expect(events).toContainEqual({ type: 'batch-dropped', batchId: 'batch-1', contactId: ALICE, reason: 'cancelled' });
        expect(offered().at(-1)?.contactId).toBe(BOB);
    });

    it('connect re-enables and reconnects', async () => {
        setup({ enabled: false });
        await service.connect();
        expect(config.get().enabled).toBe(true);
        expect(transport.getStatus().state).toBe('connected');
    });

    it('logout unlinks and disables', async () => {
        setup();
        await service.logout();
        expect(transport.getStatus().state).toBe('logged_out');
        expect(config.get().enabled).toBe(false);
    });
});

describe('BridgeService close', () => {
    it('sends queued bubbles immediately, disconnects and leaves no timers', async () => {
        setup({ realistic: { preset: 'busy' } });
        transport.receive(ALICE, 'hi');
        await vi.advanceTimersByTimeAsync(1_000);
        claimed('batch-1');
        service.reply('batch-1', 'tab-1', { text: 'one\n\ntwo' });
        transport.receive(BOB, 'pending');
        await service.close();
        expect(transport.sent()).toEqual(['one', 'two']);
        expect(transport.getStatus().state).toBe('disabled');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('is idempotent and ignores later messages', async () => {
        setup();
        await service.close();
        await service.close();
        transport.receive(ALICE, 'late');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(offered()).toEqual([]);
    });
});
