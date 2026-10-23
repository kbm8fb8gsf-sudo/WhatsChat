import { createRng, randomSeed, type Rng } from '../core/random.js';
import type { Scheduler, TimerHandle } from '../core/scheduler.js';
import { type BackoffOptions, backoffDelay } from '../transport/backoff.js';
import type { Logger } from '../util/logger.js';
import type { Login } from './login-store.js';
import { isLoginPage } from './server-url.js';
import type { BrowserSession, Launcher } from './session.js';

export interface BackgroundSettings {
    enabled: boolean;
    executablePath: string;
    /** Manual override for SillyTavern's address. Blank = the address SillyTavern announced. */
    url: string;
}

export type BackgroundState = 'off' | 'waiting' | 'starting' | 'running' | 'error';

export interface BackgroundStatus {
    readonly enabled: boolean;
    readonly state: BackgroundState;
    readonly error?: string;
    readonly browserVersion?: string;
    readonly url?: string;
    readonly nextRetryAt?: number;
}

export interface BackgroundBrowserOptions {
    launcher: Launcher;
    scheduler: Scheduler;
    logger: Logger;
    settings: () => BackgroundSettings;
    login: () => Login | null;
    rng?: Rng;
    backoff?: BackoffOptions;
    /** How long SillyTavern may take to load and start the extension in the hidden page. */
    readyTimeoutMs?: number;
}

const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 5_000, factor: 2, maxMs: 5 * 60_000, jitter: 0.1 };

/** A problem with a message that's already written for the person reading the panel. */
class BackgroundProblem extends Error {}

/**
 * Keeps a hidden SillyTavern page running so WhatsApp replies don't need a browser tab open.
 * Restarts it (with backoff) if it fails or crashes. Never throws to its caller: problems are
 * reported through status().
 */
export class BackgroundBrowser {
    private state: BackgroundState = 'off';
    private error: string | undefined;
    private nextRetryAt: number | undefined;
    private session: BrowserSession | null = null;
    private announcedUrl: string | null = null;
    private generation = 0;
    private attempt = 0;
    private retryTimer: TimerHandle | null = null;
    private lastLoggedError: string | undefined;
    private readonly listeners = new Set<(status: BackgroundStatus) => void>();
    private readonly rng: Rng;
    private readonly backoff: BackoffOptions;
    private readonly readyTimeoutMs: number;

    constructor(private readonly options: BackgroundBrowserOptions) {
        this.rng = options.rng ?? createRng(randomSeed());
        this.backoff = options.backoff ?? DEFAULT_BACKOFF;
        this.readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
    }

    /** SillyTavern has started listening; this is the loopback address to use. */
    serverStarted(url: string): void {
        this.announcedUrl = url;
        if (this.state === 'waiting') void this.restart();
    }

    /** Start, stop or restart to match the current settings and login. */
    async restart(): Promise<void> {
        await this.shutdown();
        const settings = this.options.settings();
        if (!settings.enabled) {
            this.setState('off');
            return;
        }
        if (!this.url()) {
            this.setState('waiting');
            return;
        }
        this.attempt = 0;
        void this.launch();
    }

    async stop(): Promise<void> {
        await this.shutdown();
        this.setState('off');
    }

    /** True while batches should go only to the hidden page. */
    handlesReplies(): boolean {
        return this.options.settings().enabled && ['waiting', 'starting', 'running'].includes(this.state);
    }

    status(): BackgroundStatus {
        const url = this.url();
        return {
            enabled: this.options.settings().enabled,
            state: this.state,
            ...(this.error ? { error: this.error } : {}),
            ...(this.session ? { browserVersion: this.session.version } : {}),
            ...(url ? { url } : {}),
            ...(this.nextRetryAt ? { nextRetryAt: this.nextRetryAt } : {}),
        };
    }

    onStatus(listener: (status: BackgroundStatus) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private url(): string | null {
        const override = this.options.settings().url.trim();
        return override === '' ? this.announcedUrl : override;
    }

    private async launch(): Promise<void> {
        const generation = ++this.generation;
        const url = this.url();
        if (!url) {
            this.setState('waiting');
            return;
        }
        this.setState('starting');
        const settings = this.options.settings();
        const login = this.options.login();
        let session: BrowserSession | null = null;
        try {
            session = await this.options.launcher({
                logger: this.options.logger,
                ...(settings.executablePath.trim() ? { executablePath: settings.executablePath.trim() } : {}),
                ...(login ? { httpCredentials: login } : {}),
            });
            if (generation !== this.generation) {
                await session.close();
                return;
            }
            await session.open(url);
            if (isLoginPage(session.currentUrl())) await this.logIn(session, url, login);
            try {
                await session.waitForWorker(this.readyTimeoutMs);
            } catch {
                throw new BackgroundProblem(
                    "SillyTavern opened, but the WhatsChat extension didn't start in it. Check the extension " +
                        'is installed and enabled for the SillyTavern user the background copy uses.',
                );
            }
            if (generation !== this.generation) {
                await session.close();
                return;
            }
            this.session = session;
            this.attempt = 0;
            this.lastLoggedError = undefined;
            session.onEnded((reason) => {
                if (generation !== this.generation) return;
                this.session = null;
                this.failed(new BackgroundProblem(`The hidden browser stopped (${reason}). Restarting it.`));
            });
            this.options.logger.info(`Background replies are running (Chromium ${session.version}).`);
            this.setState('running');
        } catch (error) {
            await session?.close().catch(() => undefined);
            if (generation !== this.generation) return;
            this.failed(error);
        }
    }

    private async logIn(session: BrowserSession, url: string, login: Login | null): Promise<void> {
        if (!login) {
            throw new BackgroundProblem(
                'SillyTavern asks for a login. Enter its username and password under Background replies.',
            );
        }
        const result = await session.login(login.username, login.password);
        if (!result.ok) throw new BackgroundProblem(`SillyTavern didn't accept the login: ${result.error}`);
        await session.open(url);
        if (isLoginPage(session.currentUrl())) {
            throw new BackgroundProblem('SillyTavern still shows its login page after logging in.');
        }
    }

    private failed(error: unknown): void {
        this.attempt++;
        const delay = backoffDelay(this.attempt, this.backoff, this.rng);
        const message = describeProblem(error, this.url());
        if (message !== this.lastLoggedError) {
            this.options.logger.warn(`Background replies: ${message}`);
            this.lastLoggedError = message;
        }
        this.retryTimer = this.options.scheduler.setTimeout(() => {
            this.retryTimer = null;
            void this.launch();
        }, delay);
        this.setState('error', message, this.options.scheduler.now() + delay);
    }

    private async shutdown(): Promise<void> {
        this.generation++;
        if (this.retryTimer) this.options.scheduler.clearTimeout(this.retryTimer);
        this.retryTimer = null;
        const session = this.session;
        this.session = null;
        if (session) {
            try {
                await session.close();
            } catch (error) {
                this.options.logger.debug('Error closing the hidden browser', error);
            }
        }
    }

    private setState(state: BackgroundState, error?: string, nextRetryAt?: number): void {
        this.state = state;
        this.error = error;
        this.nextRetryAt = nextRetryAt;
        const status = this.status();
        for (const listener of this.listeners) {
            try {
                listener(status);
            } catch (listenerError) {
                this.options.logger.error('Background status listener failed', listenerError);
            }
        }
    }
}

/** Turn launch failures into instructions a person can follow on an Ubuntu server. */
export function describeProblem(error: unknown, url: string | null): string {
    if (error instanceof BackgroundProblem) return error.message;
    const text = error instanceof Error ? error.message : String(error);
    if (/Cannot find (?:module|package) 'playwright-core'/.test(text)) {
        return 'playwright-core is missing. Run "npm ci" in the plugins/whatschat folder.';
    }
    if (/Executable doesn't exist|Failed to launch.*ENOENT|spawn .* ENOENT/i.test(text)) {
        return (
            'Chromium is not installed. In the plugins/whatschat folder, as the user that runs ' +
            'SillyTavern, run "npm run browser:install".'
        );
    }
    if (/missing dependencies|error while loading shared libraries/i.test(text)) {
        return (
            'Chromium is missing system libraries. In the plugins/whatschat folder run ' +
            '"sudo env PATH=$PATH npm run browser:deps" once.'
        );
    }
    if (/net::ERR_|ECONNREFUSED/.test(text)) {
        return `Could not open SillyTavern at ${url ?? 'its address'}. Set the address under Background replies.`;
    }
    return text.split('\n')[0] ?? text;
}
