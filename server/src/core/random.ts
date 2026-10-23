import { randomInt } from 'node:crypto';

/** Returns a float in [0, 1). */
export type Rng = () => number;

/** Small seeded PRNG (mulberry32), so pacing can be tested deterministically. */
export function createRng(seed: number): Rng {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function randomSeed(): number {
    return randomInt(0, 2 ** 32 - 1);
}

/** A whole number of milliseconds, uniformly between min and max. */
export function sampleRange(range: { min: number; max: number }, rng: Rng): number {
    return Math.round(range.min + rng() * (range.max - range.min));
}
