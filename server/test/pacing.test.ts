import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/config/presets.js';
import type { Pacing } from '../src/config/schema.js';
import { planDelivery, planRead, typingDurationMs } from '../src/core/pacing.js';
import { createRng, sampleRange } from '../src/core/random.js';

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);

describe('createRng', () => {
    it('is deterministic per seed and stays in [0, 1)', () => {
        const a = createRng(42);
        const b = createRng(42);
        for (let i = 0; i < 1000; i++) {
            const value = a();
            expect(value).toBe(b());
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
        }
        expect(createRng(1)()).not.toBe(createRng(2)());
    });

    it('sampleRange stays within bounds', () => {
        const rng = createRng(7);
        for (let i = 0; i < 1000; i++) {
            const value = sampleRange({ min: 100, max: 200 }, rng);
            expect(value).toBeGreaterThanOrEqual(100);
            expect(value).toBeLessThanOrEqual(200);
            expect(Number.isInteger(value)).toBe(true);
        }
        expect(sampleRange({ min: 5, max: 5 }, rng)).toBe(5);
    });
});

describe('typingDurationMs', () => {
    const steady: Pacing = { ...PRESETS.natural, typingJitter: 0, typingCharsPerSec: 5 };

    it('scales with visible characters, so emoji count once', () => {
        expect(typingDurationMs('a'.repeat(50), steady, createRng(1))).toBe(10_000);
        expect(typingDurationMs('\u{1F60A}'.repeat(50), steady, createRng(1))).toBe(10_000);
        // Family emoji: several code points joined into one visible character.
        const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
        expect(typingDurationMs(family.repeat(50), steady, createRng(1))).toBe(10_000);
    });

    it('clamps to the configured min and max', () => {
        expect(typingDurationMs('ok', steady, createRng(1))).toBe(steady.typingMinMs);
        expect(typingDurationMs('a'.repeat(10_000), steady, createRng(1))).toBe(steady.typingMaxMs);
    });

    it('keeps jitter within the configured fraction', () => {
        const pacing: Pacing = { ...steady, typingJitter: 0.2, typingMinMs: 0, typingMaxMs: 1_000_000 };
        for (const seed of SEEDS) {
            const value = typingDurationMs('a'.repeat(50), pacing, createRng(seed));
            expect(value).toBeGreaterThanOrEqual(8_000);
            expect(value).toBeLessThanOrEqual(12_000);
        }
    });

    it('is zero for the off preset', () => {
        expect(typingDurationMs('a long message indeed', PRESETS.off, createRng(1))).toBe(0);
    });
});

describe('planRead', () => {
    it.each(['quick', 'natural', 'busy'] as const)('stays within the %s preset ranges', (name) => {
        const pacing = PRESETS[name];
        for (const seed of SEEDS) {
            const plan = planRead({ batchReadyAt: 1_000, claimedAt: 1_000, pacing, rng: createRng(seed) });
            expect(plan.readAt).toBeGreaterThanOrEqual(1_000 + pacing.readDelayMs.min);
            expect(plan.readAt).toBeLessThanOrEqual(1_000 + pacing.readDelayMs.max);
            expect(plan.typingFrom - plan.readAt).toBeGreaterThanOrEqual(pacing.thinkMs.min);
            expect(plan.typingFrom - plan.readAt).toBeLessThanOrEqual(pacing.thinkMs.max);
        }
    });

    it('never reads before SillyTavern claimed the batch', () => {
        const plan = planRead({ batchReadyAt: 0, claimedAt: 10 * 60_000, pacing: PRESETS.quick, rng: createRng(3) });
        expect(plan.readAt).toBe(10 * 60_000);
    });

    it('reads immediately with the off preset', () => {
        expect(planRead({ batchReadyAt: 0, claimedAt: 500, pacing: PRESETS.off, rng: createRng(1) })).toEqual({
            readAt: 500,
            typingFrom: 500,
        });
    });
});

describe('planDelivery', () => {
    const bubbles = ['hey!', 'how was your day?', 'mine was pretty good actually'];

    it('sends everything at once with the off preset', () => {
        const steps = planDelivery({ typingFrom: 0, replyAt: 5_000, bubbles, pacing: PRESETS.off, rng: createRng(1) });
        expect(steps).toEqual([
            { at: 5_000, kind: 'send', bubble: 0 },
            { at: 5_000, kind: 'send', bubble: 1 },
            { at: 5_000, kind: 'send', bubble: 2 },
        ]);
    });

    it.each(['quick', 'natural', 'busy'] as const)('orders typing and sends sensibly with %s', (name) => {
        const pacing = PRESETS[name];
        for (const seed of SEEDS) {
            const steps = planDelivery({ typingFrom: 10_000, replyAt: 12_000, bubbles, pacing, rng: createRng(seed) });
            expect(steps.map((s) => `${s.kind}${String(s.bubble)}`)).toEqual([
                'send0', 'typing1', 'send1', 'typing2', 'send2',
            ]);
            for (let i = 1; i < steps.length; i++) {
                expect(steps[i]!.at).toBeGreaterThanOrEqual(steps[i - 1]!.at);
            }
            const first = steps[0]!;
            expect(first.at).toBeGreaterThanOrEqual(12_000);
            expect(first.at).toBeGreaterThanOrEqual(10_000 + pacing.typingMinMs);
            // The gap before each later bubble's typing is within the configured range.
            expect(steps[1]!.at - first.at).toBeGreaterThanOrEqual(pacing.bubbleGapMs.min);
            expect(steps[1]!.at - first.at).toBeLessThanOrEqual(pacing.bubbleGapMs.max);
        }
    });

    it('counts generation time as typing for the first bubble', () => {
        const pacing: Pacing = { ...PRESETS.natural, typingJitter: 0 };
        // Typing started at 0; the 4-char bubble needs the 1.5 s minimum; the reply came at 60 s.
        const late = planDelivery({ typingFrom: 0, replyAt: 60_000, bubbles: ['hey!'], pacing, rng: createRng(1) });
        expect(late).toEqual([{ at: 60_000, kind: 'send', bubble: 0 }]);
        // The reply came instantly, so the send waits for the typing to look finished.
        const early = planDelivery({ typingFrom: 0, replyAt: 0, bubbles: ['hey!'], pacing, rng: createRng(1) });
        expect(early).toEqual([{ at: 1_500, kind: 'send', bubble: 0 }]);
    });

    it('omits typing steps when typing is hidden', () => {
        const pacing: Pacing = { ...PRESETS.natural, showTyping: false };
        const steps = planDelivery({ typingFrom: 0, replyAt: 0, bubbles, pacing, rng: createRng(1) });
        expect(steps.every((s) => s.kind === 'send')).toBe(true);
        expect(steps[2]!.at).toBeGreaterThan(steps[1]!.at);
    });

    it('is deterministic for a given seed and returns nothing for no bubbles', () => {
        const input = { typingFrom: 0, replyAt: 0, bubbles, pacing: PRESETS.natural };
        expect(planDelivery({ ...input, rng: createRng(9) })).toEqual(planDelivery({ ...input, rng: createRng(9) }));
        expect(planDelivery({ ...input, bubbles: [], rng: createRng(9) })).toEqual([]);
    });
});
