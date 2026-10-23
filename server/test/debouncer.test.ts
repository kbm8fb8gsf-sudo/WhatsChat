import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAt, type DebounceOptions, Debouncer } from '../src/core/debouncer.js';
import { systemScheduler } from '../src/core/scheduler.js';
import { silentLogger } from '../src/util/logger.js';

let options: DebounceOptions;
let batches: [string, string[]][];
let debouncer: Debouncer<string>;

beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    options = { quietMs: 1_000, maxWaitMs: 5_000, maxMessages: 4 };
    batches = [];
    debouncer = new Debouncer<string>(systemScheduler, () => options, (key, items) => batches.push([key, items]), silentLogger);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('closeAt', () => {
    it('is the earlier of quiet and max wait', () => {
        expect(closeAt({ firstAt: 0, lastAt: 0 }, options)).toBe(1_000);
        expect(closeAt({ firstAt: 0, lastAt: 4_500 }, options)).toBe(5_000);
    });
});

describe('Debouncer', () => {
    it('closes a batch after the quiet period', () => {
        debouncer.push('a', 'hi');
        vi.advanceTimersByTime(999);
        expect(batches).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(batches).toEqual([['a', ['hi']]]);
        expect(debouncer.size).toBe(0);
    });

    it('extends the batch while messages keep arriving', () => {
        debouncer.push('a', '1');
        vi.advanceTimersByTime(800);
        debouncer.push('a', '2');
        vi.advanceTimersByTime(800);
        expect(batches).toEqual([]);
        vi.advanceTimersByTime(200);
        expect(batches).toEqual([['a', ['1', '2']]]);
    });

    it('closes at maxWaitMs even if messages keep arriving', () => {
        options = { ...options, maxMessages: 100 };
        debouncer.push('a', '0');
        for (let i = 1; i <= 10; i++) {
            vi.advanceTimersByTime(600);
            if (batches.length === 0) debouncer.push('a', String(i));
        }
        expect(batches[0]?.[1]).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
        expect(batches[0]?.[1].length).toBe(9);
    });

    it('closes immediately at maxMessages', () => {
        for (const item of ['1', '2', '3', '4']) debouncer.push('a', item);
        expect(batches).toEqual([['a', ['1', '2', '3', '4']]]);
        vi.advanceTimersByTime(10_000);
        expect(batches.length).toBe(1);
    });

    it('keeps contacts separate', () => {
        debouncer.push('a', 'from a');
        vi.advanceTimersByTime(500);
        debouncer.push('b', 'from b');
        vi.advanceTimersByTime(500);
        expect(batches).toEqual([['a', ['from a']]]);
        vi.advanceTimersByTime(500);
        expect(batches).toEqual([['a', ['from a']], ['b', ['from b']]]);
    });

    it('can flush or cancel early', () => {
        debouncer.push('a', 'x');
        debouncer.push('b', 'y');
        debouncer.push('c', 'z');
        debouncer.flush('a');
        debouncer.cancel('b');
        expect(batches).toEqual([['a', ['x']]]);
        debouncer.cancelAll();
        vi.advanceTimersByTime(10_000);
        expect(batches).toEqual([['a', ['x']]]);
    });

    it('reads options live, so config changes apply to the next message', () => {
        debouncer.push('a', '1');
        options = { ...options, quietMs: 3_000 };
        debouncer.push('a', '2');
        vi.advanceTimersByTime(2_999);
        expect(batches).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(batches.length).toBe(1);
    });

    it('contains errors thrown by the batch handler', () => {
        const logger = { ...silentLogger, error: vi.fn() };
        const failing = new Debouncer<string>(systemScheduler, () => options, () => {
            throw new Error('boom');
        }, logger);
        failing.push('a', 'x');
        expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
        expect(logger.error).toHaveBeenCalledOnce();
    });
});
