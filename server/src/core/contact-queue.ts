import type { Logger } from '../util/logger.js';
import type { Scheduler, TimerHandle } from './scheduler.js';

export interface TimedTask {
    /** Absolute time (ms) before which the task must not start. */
    readonly at: number;
    readonly label: string;
    /** Essential tasks (sending a message) still run when the queue is flushed at shutdown. */
    readonly essential: boolean;
    /** Groups tasks (e.g. by batch id) for selective cancellation. */
    readonly tag: string;
    readonly run: () => Promise<void>;
}

interface Lane {
    tasks: TimedTask[];
    timer: TimerHandle | null;
    running: boolean;
}

/**
 * One ordered lane of timed tasks per contact. Tasks in a lane run strictly one after another,
 * each no earlier than its `at`; different contacts' lanes run independently.
 * If a task fails, the rest of the tasks with the same tag are dropped, so a contact never
 * gets the tail of a reply whose middle failed.
 */
export class ContactQueue {
    private readonly lanes = new Map<string, Lane>();
    private readonly idleWaiters = new Set<() => void>();
    private flushing = false;
    private closed = false;

    constructor(
        private readonly scheduler: Scheduler,
        private readonly logger: Logger,
    ) {}

    schedule(key: string, tasks: readonly TimedTask[]): void {
        if (this.closed) {
            this.logger.warn(`Ignoring ${String(tasks.length)} task(s) for ${key}: the queue is shut down`);
            return;
        }
        const lane = this.lanes.get(key) ?? { tasks: [], timer: null, running: false };
        lane.tasks.push(...tasks);
        this.lanes.set(key, lane);
        this.pump(key, lane);
    }

    /** Cancel pending tasks for `key` (all, or those matching `predicate`). A running task finishes. */
    cancel(key: string, predicate: (task: TimedTask) => boolean = () => true): number {
        const lane = this.lanes.get(key);
        if (!lane) return 0;
        const before = lane.tasks.length;
        lane.tasks = lane.tasks.filter((task) => !predicate(task));
        const removed = before - lane.tasks.length;
        if (removed > 0) {
            this.clearTimer(lane);
            this.pump(key, lane);
        }
        return removed;
    }

    cancelAll(): void {
        for (const [key, lane] of this.lanes) {
            lane.tasks = [];
            this.clearTimer(lane);
            this.removeIfIdle(key, lane);
        }
    }

    pending(key?: string): number {
        if (key !== undefined) return this.lanes.get(key)?.tasks.length ?? 0;
        let total = 0;
        for (const lane of this.lanes.values()) total += lane.tasks.length;
        return total;
    }

    /** Resolves once every lane is empty and nothing is running. */
    whenIdle(): Promise<void> {
        if (this.lanes.size === 0) return Promise.resolve();
        return new Promise((resolve) => this.idleWaiters.add(resolve));
    }

    /**
     * Shutdown: stop accepting tasks, drop non-essential ones, run essential ones immediately
     * (ignoring their times), and give up on whatever is left after `timeoutMs`.
     */
    async flush(timeoutMs: number): Promise<void> {
        this.closed = true;
        this.flushing = true;
        for (const [key, lane] of this.lanes) {
            lane.tasks = lane.tasks.filter((task) => task.essential);
            this.clearTimer(lane);
            this.pump(key, lane);
        }
        let timer: TimerHandle | undefined;
        const timedOut = new Promise<'timeout'>((resolve) => {
            timer = this.scheduler.setTimeout(() => {
                resolve('timeout');
            }, timeoutMs);
        });
        const result = await Promise.race([this.whenIdle().then(() => 'idle' as const), timedOut]);
        if (timer !== undefined) this.scheduler.clearTimeout(timer);
        if (result === 'timeout') {
            this.logger.warn(`Gave up on ${String(this.pending())} queued task(s) at shutdown`);
            this.cancelAll();
        }
    }

    private pump(key: string, lane: Lane): void {
        if (lane.running || lane.timer) return;
        const next = lane.tasks[0];
        if (!next) {
            this.removeIfIdle(key, lane);
            return;
        }
        const delay = this.flushing ? 0 : next.at - this.scheduler.now();
        if (delay > 0) {
            lane.timer = this.scheduler.setTimeout(() => {
                lane.timer = null;
                this.pump(key, lane);
            }, delay);
            return;
        }
        lane.tasks.shift();
        lane.running = true;
        void this.execute(key, lane, next);
    }

    private async execute(key: string, lane: Lane, task: TimedTask): Promise<void> {
        try {
            await task.run();
        } catch (error) {
            const dropped = lane.tasks.filter((t) => t.tag === task.tag).length;
            lane.tasks = lane.tasks.filter((t) => t.tag !== task.tag);
            this.logger.error(
                `Task "${task.label}" for ${key} failed; dropped ${String(dropped)} remaining task(s) for it`,
                error,
            );
        } finally {
            lane.running = false;
            this.pump(key, lane);
        }
    }

    private clearTimer(lane: Lane): void {
        if (lane.timer) {
            this.scheduler.clearTimeout(lane.timer);
            lane.timer = null;
        }
    }

    private removeIfIdle(key: string, lane: Lane): void {
        if (lane.running || lane.tasks.length > 0) return;
        this.lanes.delete(key);
        if (this.lanes.size === 0) {
            for (const resolve of this.idleWaiters) resolve();
            this.idleWaiters.clear();
        }
    }
}
