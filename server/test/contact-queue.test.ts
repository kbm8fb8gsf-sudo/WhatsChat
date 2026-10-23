import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactQueue, type TimedTask } from '../src/core/contact-queue.js';
import { systemScheduler } from '../src/core/scheduler.js';
import { silentLogger } from '../src/util/logger.js';

let log: string[];
let queue: ContactQueue;

beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    log = [];
    queue = new ContactQueue(systemScheduler, silentLogger);
});

afterEach(() => {
    vi.useRealTimers();
});

function task(label: string, at: number, extra: Partial<TimedTask> = {}): TimedTask {
    return {
        at,
        label,
        essential: true,
        tag: 'batch-1',
        run: () => {
            log.push(`${label}@${String(Date.now())}`);
            return Promise.resolve();
        },
        ...extra,
    };
}

describe('ContactQueue', () => {
    it('runs each task no earlier than its time, in order', async () => {
        queue.schedule('a', [task('read', 1_000), task('send', 3_000)]);
        await vi.advanceTimersByTimeAsync(999);
        expect(log).toEqual([]);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(log).toEqual(['read@1000', 'send@3000']);
        expect(queue.pending()).toBe(0);
    });

    it('runs overdue tasks immediately', async () => {
        vi.setSystemTime(10_000);
        queue.schedule('a', [task('late', 1_000)]);
        await vi.advanceTimersByTimeAsync(0);
        expect(log).toEqual(['late@10000']);
    });

    it('waits for a slow task before starting the next one in the same lane', async () => {
        const slow = task('slow', 0, {
            run: async () => {
                await new Promise((resolve) => setTimeout(resolve, 5_000));
                log.push(`slow done@${String(Date.now())}`);
            },
        });
        queue.schedule('a', [slow, task('next', 1_000)]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(log).toEqual(['slow done@5000', 'next@5000']);
    });

    it('runs different contacts independently', async () => {
        const slow = task('a-slow', 0, {
            run: () => new Promise((resolve) => setTimeout(resolve, 5_000)),
        });
        queue.schedule('a', [slow]);
        queue.schedule('b', [task('b-send', 1_000)]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(log).toEqual(['b-send@1000']);
    });

    it('drops the rest of a failed batch but keeps other batches', async () => {
        const logger = { ...silentLogger, error: vi.fn() };
        queue = new ContactQueue(systemScheduler, logger);
        queue.schedule('a', [
            task('send0', 100, { run: () => Promise.reject(new Error('network down')) }),
            task('send1', 200),
            task('other', 300, { tag: 'batch-2' }),
        ]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(log).toEqual(['other@300']);
        expect(logger.error).toHaveBeenCalledOnce();
    });

    it('cancels pending tasks selectively', async () => {
        queue.schedule('a', [task('typing', 100, { tag: 'x' }), task('send', 200, { tag: 'y' })]);
        expect(queue.cancel('a', (t) => t.tag === 'x')).toBe(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(log).toEqual(['send@200']);
        expect(queue.cancel('missing')).toBe(0);
    });

    it('cancelAll stops everything', async () => {
        queue.schedule('a', [task('a', 100)]);
        queue.schedule('b', [task('b', 100)]);
        queue.cancelAll();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(log).toEqual([]);
        await expect(queue.whenIdle()).resolves.toBeUndefined();
    });

    it('flush runs essential tasks immediately, drops the rest and refuses new work', async () => {
        queue.schedule('a', [
            task('typing', 60_000, { essential: false }),
            task('send0', 60_000),
            task('send1', 120_000),
        ]);
        const flushed = queue.flush(5_000);
        await vi.advanceTimersByTimeAsync(0);
        await flushed;
        expect(log).toEqual(['send0@0', 'send1@0']);

        queue.schedule('a', [task('after', 0)]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(log).toEqual(['send0@0', 'send1@0']);
    });

    it('flush gives up after its timeout', async () => {
        const logger = { ...silentLogger, warn: vi.fn() };
        queue = new ContactQueue(systemScheduler, logger);
        queue.schedule('a', [
            task('hangs', 0, { run: () => new Promise<void>(() => undefined) }),
            task('never', 0),
        ]);
        await vi.advanceTimersByTimeAsync(0);
        const flushed = queue.flush(5_000);
        await vi.advanceTimersByTimeAsync(5_000);
        await flushed;
        expect(logger.warn).toHaveBeenCalledOnce();
        expect(queue.pending()).toBe(0);
        expect(log).toEqual([]);
    });

    it('whenIdle resolves once the queue drains', async () => {
        queue.schedule('a', [task('one', 1_000)]);
        let idle = false;
        void queue.whenIdle().then(() => {
            idle = true;
        });
        await vi.advanceTimersByTimeAsync(999);
        expect(idle).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(idle).toBe(true);
    });
});
