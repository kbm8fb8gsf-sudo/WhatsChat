import type { Logger } from '../util/logger.js';

/**
 * One hidden browser showing SillyTavern. The interface is all BackgroundBrowser needs, so it
 * can be tested without a real browser; playwright-session.ts provides the real one.
 */
export interface BrowserSession {
    /** e.g. "156.0.8078.4" */
    readonly version: string;
    /** Navigate; resolves with the HTTP status of the page (null if unknown). */
    open(url: string): Promise<number | null>;
    currentUrl(): string;
    /** Log in through SillyTavern's own login API, from inside the page. */
    login(username: string, password: string): Promise<{ ok: true } | { ok: false; error: string }>;
    /** Resolves once the WhatsChat extension has started in worker mode. */
    waitForWorker(timeoutMs: number): Promise<void>;
    /** Called once if the page crashes or the browser goes away. */
    onEnded(listener: (reason: string) => void): void;
    close(): Promise<void>;
}

export interface LaunchOptions {
    executablePath?: string;
    /** Sent if SillyTavern asks for HTTP basic auth. */
    httpCredentials?: { username: string; password: string };
    logger: Logger;
}

export type Launcher = (options: LaunchOptions) => Promise<BrowserSession>;

/** Flag the extension checks to know it's running in the hidden browser. */
export const WORKER_FLAG = '__WHATSCHAT_WORKER__';
/** Flag the extension sets once it's connected and ready for batches. */
export const WORKER_READY_FLAG = '__WHATSCHAT_WORKER_READY__';
