import type { Pacing, PresetName } from './schema.js';

/** Realistic-text presets confirmed in PLAN.md section 3. All durations are milliseconds. */
export const PRESETS: Readonly<Record<PresetName, Readonly<Pacing>>> = {
    off: {
        readDelayMs: { min: 0, max: 0 },
        thinkMs: { min: 0, max: 0 },
        typingCharsPerSec: 100,
        typingMinMs: 0,
        typingMaxMs: 0,
        typingJitter: 0,
        bubbleGapMs: { min: 0, max: 0 },
        split: false,
        showTyping: false,
    },
    quick: {
        readDelayMs: { min: 2_000, max: 8_000 },
        thinkMs: { min: 1_000, max: 3_000 },
        typingCharsPerSec: 7,
        typingMinMs: 1_500,
        typingMaxMs: 25_000,
        typingJitter: 0.2,
        bubbleGapMs: { min: 600, max: 1_500 },
        split: true,
        showTyping: true,
    },
    natural: {
        readDelayMs: { min: 5_000, max: 40_000 },
        thinkMs: { min: 2_000, max: 6_000 },
        typingCharsPerSec: 4.5,
        typingMinMs: 1_500,
        typingMaxMs: 25_000,
        typingJitter: 0.2,
        bubbleGapMs: { min: 1_200, max: 3_500 },
        split: true,
        showTyping: true,
    },
    busy: {
        readDelayMs: { min: 60_000, max: 480_000 },
        thinkMs: { min: 5_000, max: 20_000 },
        typingCharsPerSec: 3.5,
        typingMinMs: 1_500,
        typingMaxMs: 25_000,
        typingJitter: 0.2,
        bubbleGapMs: { min: 2_000, max: 6_000 },
        split: true,
        showTyping: true,
    },
};
