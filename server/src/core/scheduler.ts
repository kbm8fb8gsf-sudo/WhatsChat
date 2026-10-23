export type TimerHandle = ReturnType<typeof setTimeout>;

/** Clock and timers, injectable so timing logic can be tested with fake timers. */
export interface Scheduler {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
}

export const systemScheduler: Scheduler = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => {
        const handle = setTimeout(callback, Math.max(0, delayMs));
        // Pending sends must not keep a stopping process alive; exit() flushes them explicitly.
        handle.unref();
        return handle;
    },
    clearTimeout: (handle) => {
        clearTimeout(handle);
    },
};

export function sleep(scheduler: Scheduler, delayMs: number): Promise<void> {
    return new Promise((resolve) => scheduler.setTimeout(resolve, delayMs));
}
