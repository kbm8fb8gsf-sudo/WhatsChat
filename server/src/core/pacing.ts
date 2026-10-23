import type { Pacing } from '../config/schema.js';
import { type Rng, sampleRange } from './random.js';

/**
 * Pacing calculator. Pure: all times are absolute milliseconds supplied by the caller,
 * and randomness comes from the injected Rng.
 *
 * Timeline for one batch:
 *   batch ready → (read delay) → marked read → (think) → typing… → bubble 1 sent
 *     → (gap) → typing… → bubble 2 sent → …
 * The reply is generated in parallel. Time spent generating counts towards bubble 1's
 * typing, so a slow model only delays bubble 1 if it's slower than the planned typing.
 */

export interface ReadPlan {
    /** When to mark the batch read (blue ticks). */
    readAt: number;
    /** When "typing…" starts for the first bubble (only shown if pacing.showTyping). */
    typingFrom: number;
}

/** Plan the read receipt. Nothing is marked read before SillyTavern has claimed the batch. */
export function planRead(input: { batchReadyAt: number; claimedAt: number; pacing: Pacing; rng: Rng }): ReadPlan {
    const readAt = Math.max(input.claimedAt, input.batchReadyAt + sampleRange(input.pacing.readDelayMs, input.rng));
    return { readAt, typingFrom: readAt + sampleRange(input.pacing.thinkMs, input.rng) };
}

export function typingDurationMs(text: string, pacing: Pacing, rng: Rng): number {
    if (pacing.typingMaxMs === 0) return 0;
    const chars = countGraphemes(text);
    const base = (chars / pacing.typingCharsPerSec) * 1000;
    const jitter = 1 + pacing.typingJitter * (rng() * 2 - 1);
    return Math.round(Math.min(pacing.typingMaxMs, Math.max(pacing.typingMinMs, base * jitter)));
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Characters as a person sees them: an emoji, even a multi-part one, counts once. */
function countGraphemes(text: string): number {
    let count = 0;
    for (const segment of graphemes.segment(text)) {
        if (segment.segment !== '') count++;
    }
    return count;
}

export type DeliveryStep =
    | { readonly at: number; readonly kind: 'typing'; readonly bubble: number }
    | { readonly at: number; readonly kind: 'send'; readonly bubble: number };

/**
 * Plan sending the bubbles once the reply exists. Typing for bubble 0 was already started at
 * `typingFrom` (see planRead), so the plan starts with bubble 0's send.
 */
export function planDelivery(input: {
    typingFrom: number;
    replyAt: number;
    bubbles: readonly string[];
    pacing: Pacing;
    rng: Rng;
}): DeliveryStep[] {
    const { bubbles, pacing, rng } = input;
    const steps: DeliveryStep[] = [];
    let previousSend = 0;

    bubbles.forEach((text, bubble) => {
        if (bubble === 0) {
            previousSend = Math.max(input.replyAt, input.typingFrom + typingDurationMs(text, pacing, rng));
            steps.push({ at: previousSend, kind: 'send', bubble });
            return;
        }
        const typingAt = previousSend + sampleRange(pacing.bubbleGapMs, rng);
        if (pacing.showTyping) steps.push({ at: typingAt, kind: 'typing', bubble });
        previousSend = typingAt + typingDurationMs(text, pacing, rng);
        steps.push({ at: previousSend, kind: 'send', bubble });
    });
    return steps;
}
