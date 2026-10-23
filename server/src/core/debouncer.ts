import type { Logger } from '../util/logger.js';
import type { Scheduler, TimerHandle } from './scheduler.js';

export interface DebounceOptions {
    /** Close a batch after this long without a new message. */
    quietMs: number;
    /** Close a batch this long after its first message, even if messages keep coming. */
    maxWaitMs: number;
    /** Close a batch as soon as it has this many messages. */
    maxMessages: number;
}

interface Pending<T> {
    items: T[];
    firstAt: number;
    lastAt: number;
    timer: TimerHandle | null;
}

/** When a pending batch should close. Pure. */
export function closeAt(pending: { firstAt: number; lastAt: number }, options: DebounceOptions): number {
    return Math.min(pending.lastAt + options.quietMs, pending.firstAt + options.maxWaitMs);
}

/**
 * Groups messages that arrive close together per key (contact), the way people send a thought
 * as several quick messages, and hands each closed group to `onBatch`.
 */
export class Debouncer<T> {
    private readonly pending = new Map<string, Pending<T>>();

    constructor(
        private readonly scheduler: Scheduler,
        private readonly options: () => DebounceOptions,
        private readonly onBatch: (key: string, items: T[]) => void,
        private readonly logger: Logger,
    ) {}

    push(key: string, item: T): void {
        const now = this.scheduler.now();
        const existing = this.pending.get(key);
        const pending = existing ?? { items: [], firstAt: now, lastAt: now, timer: null };
        pending.items.push(item);
        pending.lastAt = now;
        this.pending.set(key, pending);

        const options = this.options();
        if (pending.items.length >= options.maxMessages) {
            this.flush(key);
            return;
        }
        if (pending.timer) this.scheduler.clearTimeout(pending.timer);
        pending.timer = this.scheduler.setTimeout(() => {
            this.flush(key);
        }, closeAt(pending, options) - now);
    }

    /** Close the batch for `key` now. */
    flush(key: string): void {
        const pending = this.take(key);
        if (!pending) return;
        try {
            this.onBatch(key, pending.items);
        } catch (error) {
            this.logger.error(`Failed to hand over a message batch for ${key}`, error);
        }
    }

    /** Drop the pending batch for `key` without handing it over. */
    cancel(key: string): void {
        this.take(key);
    }

    cancelAll(): void {
        for (const key of [...this.pending.keys()]) this.take(key);
    }

    get size(): number {
        return this.pending.size;
    }

    private take(key: string): Pending<T> | undefined {
        const pending = this.pending.get(key);
        if (!pending) return undefined;
        if (pending.timer) this.scheduler.clearTimeout(pending.timer);
        this.pending.delete(key);
        return pending;
    }
}
