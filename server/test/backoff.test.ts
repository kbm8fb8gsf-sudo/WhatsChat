import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/random.js';
import { backoffDelay, DEFAULT_BACKOFF } from '../src/transport/backoff.js';

describe('backoffDelay', () => {
    const exact = { ...DEFAULT_BACKOFF, jitter: 0 };

    it('grows exponentially from the base', () => {
        expect([1, 2, 3, 4].map((n) => backoffDelay(n, exact, createRng(1)))).toEqual([2_000, 4_000, 8_000, 16_000]);
    });

    it('caps at the maximum, even with jitter', () => {
        expect(backoffDelay(50, exact, createRng(1))).toBe(DEFAULT_BACKOFF.maxMs);
        for (let seed = 0; seed < 50; seed++) {
            expect(backoffDelay(50, DEFAULT_BACKOFF, createRng(seed))).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
        }
    });

    it('keeps jitter within bounds', () => {
        for (let seed = 0; seed < 50; seed++) {
            const delay = backoffDelay(3, DEFAULT_BACKOFF, createRng(seed));
            expect(delay).toBeGreaterThanOrEqual(6_400);
            expect(delay).toBeLessThanOrEqual(9_600);
        }
    });
});
