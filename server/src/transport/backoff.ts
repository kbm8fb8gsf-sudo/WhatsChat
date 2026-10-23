import type { Rng } from '../core/random.js';

export interface BackoffOptions {
    baseMs: number;
    factor: number;
    maxMs: number;
    /** Random spread as a fraction of the delay, e.g. 0.2 for ±20%. */
    jitter: number;
}

export const DEFAULT_BACKOFF: Readonly<BackoffOptions> = { baseMs: 2_000, factor: 2, maxMs: 5 * 60_000, jitter: 0.2 };

/** Exponential backoff with jitter. `attempt` starts at 1. Pure. */
export function backoffDelay(attempt: number, options: BackoffOptions, rng: Rng): number {
    const exponent = Math.max(0, attempt - 1);
    const capped = Math.min(options.maxMs, options.baseMs * options.factor ** exponent);
    const spread = 1 + options.jitter * (rng() * 2 - 1);
    return Math.round(Math.min(options.maxMs, capped * spread));
}
