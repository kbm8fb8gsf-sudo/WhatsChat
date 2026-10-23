import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BackgroundBrowser,
    type BackgroundSettings,
    type BackgroundStatus,
    describeProblem,
} from '../src/background/background-browser.js';
import type { Login } from '../src/background/login-store.js';
import type { BrowserSession, LaunchOptions } from '../src/background/session.js';
import { createRng } from '../src/core/random.js';
import { systemScheduler } from '../src/core/scheduler.js';
import { silentLogger } from '../src/util/logger.js';

const URL_ = 'http://127.0.0.1:8000/';

interface FakeSession extends BrowserSession {
    opened: string[];
    logins: [string, string][];
    closed: boolean;
    end(reason: string): void;
}

interface Behaviour {
    redirectToLogin?: boolean;
    loginResult?: { ok: true } | { ok: false; error: string };
    staysOnLogin?: boolean;
    workerNeverReady?: boolean;
}

function fakeSession(behaviour: Behaviour = {}): FakeSession {
    let current = 'about:blank';
    let loggedIn = false;
    let ended: ((reason: string) => void) | null = null;
    const session: FakeSession = {
        version: '156.0.0.0',
        opened: [],
        logins: [],
        closed: false,
        open(url) {
            session.opened.push(url);
            const needsLogin = behaviour.redirectToLogin && (!loggedIn || behaviour.staysOnLogin);
            current = needsLogin ? `${url}login` : url;
            return Promise.resolve();
        },
        currentUrl: () => current,
        login(username, password) {
            session.logins.push([username, password]);
            const result = behaviour.loginResult ?? { ok: true as const };
            if (result.ok) loggedIn = true;
            return Promise.resolve(result);
        },
        waitForWorker: () =>
            behaviour.workerNeverReady ? Promise.reject(new Error('Timeout 120000ms exceeded')) : Promise.resolve(),
        onEnded(listener) {
            ended = listener;
        },
        close() {
            session.closed = true;
            return Promise.resolve();
        },
        end(reason) {
            ended?.(reason);
        },
    };
    return session;
}

let settings: BackgroundSettings;
let login: Login | null;
let launches: LaunchOptions[];
let sessions: FakeSession[];
let behaviour: Behaviour;
let launchError: Error | null;
let statuses: BackgroundStatus[];
let background: BackgroundBrowser;

beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    settings = { enabled: true, executablePath: '', url: '' };
    login = null;
    launches = [];
    sessions = [];
    behaviour = {};
    launchError = null;
    statuses = [];
    background = new BackgroundBrowser({
        launcher: (options) => {
            launches.push(options);
            if (launchError) return Promise.reject(launchError);
            const session = fakeSession(behaviour);
            sessions.push(session);
            return Promise.resolve(session);
        },
        scheduler: systemScheduler,
        logger: silentLogger,
        settings: () => settings,
        login: () => login,
        rng: createRng(1),
        backoff: { baseMs: 1_000, factor: 2, maxMs: 60_000, jitter: 0 },
    });
    background.onStatus((s) => statuses.push(s));
});

afterEach(async () => {
    await background.stop();
    vi.useRealTimers();
});

describe('BackgroundBrowser', () => {
    it('stays off when disabled', async () => {
        settings.enabled = false;
        await background.restart();
        expect(background.status()).toEqual({ enabled: false, state: 'off' });
        expect(launches).toEqual([]);
        expect(background.handlesReplies()).toBe(false);
    });

    it('waits for SillyTavern to announce its address, then starts', async () => {
        await background.restart();
        expect(background.status().state).toBe('waiting');
        expect(background.handlesReplies()).toBe(true);

        background.serverStarted(URL_);
        await vi.advanceTimersByTimeAsync(0);
        expect(sessions[0]?.opened).toEqual([URL_]);
        expect(background.status()).toEqual({
            enabled: true,
            state: 'running',
            browserVersion: '156.0.0.0',
            url: URL_,
        });
        expect(statuses.map((s) => s.state)).toEqual(['waiting', 'starting', 'running']);
    });

    it('prefers an address set in the settings', async () => {
        settings.url = 'https://127.0.0.1:9000/';
        background.serverStarted(URL_);
        await background.restart();
        await vi.advanceTimersByTimeAsync(0);
        expect(sessions[0]?.opened).toEqual(['https://127.0.0.1:9000/']);
    });

    it('passes the Chrome path and the login (for HTTP basic auth) to the launcher', async () => {
        settings.executablePath = ' /usr/bin/chromium ';
        login = { username: 'me', password: 'secret' };
        background.serverStarted(URL_);
        await background.restart();
        await vi.advanceTimersByTimeAsync(0);
        expect(launches[0]).toMatchObject({
            executablePath: '/usr/bin/chromium',
            httpCredentials: { username: 'me', password: 'secret' },
        });
    });

    it('logs in when SillyTavern shows its login page', async () => {
        behaviour = { redirectToLogin: true };
        login = { username: 'lewis', password: 'pw' };
        background.serverStarted(URL_);
        await background.restart();
        await vi.advanceTimersByTimeAsync(0);
        expect(sessions[0]?.logins).toEqual([['lewis', 'pw']]);
        expect(sessions[0]?.opened).toEqual([URL_, URL_]);
        expect(background.status().state).toBe('running');
    });

    it.each([
        [{ redirectToLogin: true }, null, 'SillyTavern asks for a login'],
        [{ redirectToLogin: true, loginResult: { ok: false as const, error: 'Incorrect credentials' } }, { username: 'a', password: 'b' }, "didn't accept the login: Incorrect credentials"],
        [{ redirectToLogin: true, staysOnLogin: true }, { username: 'a', password: 'b' }, 'still shows its login page'],
        [{ workerNeverReady: true }, null, "the WhatsChat extension didn't start"],
    ])('explains login and startup problems (%#)', async (b, l, message) => {
        behaviour = b;
        login = l;
        background.serverStarted(URL_);
        await background.restart();
        await vi.advanceTimersByTimeAsync(0);
        const status = background.status();
        expect(status.state).toBe('error');
        expect(status.error).toContain(message);
        expect(sessions[0]?.closed).toBe(true);
        expect(background.handlesReplies()).toBe(false);
    });

    it('retries with backoff and recovers', async () => {
        launchError = new Error("browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium");
        background.serverStarted(URL_);
        await background.restart();
        await vi.advanceTimersByTimeAsync(0);
        expect(background.status()).toMatchObject({ state: 'error', nextRetryAt: 1_000 });
        expect(background.status().error).toContain('npm run browser:install');

        await vi.advanceTimersByTimeAsync(1_000);
        expect(launches.length).toBe(2);
        expect(background.status().nextRetryAt).toBe(1_000 + 2_000);

        launchError = null;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(background.status().state).toBe('running');
    });

    it('restarts the browser if it crashes', async () => {
        background.serverStarted(URL_);
        await background.restart();
        await vi.advanceTimersByTimeAsync(0);
        sessions[0]?.end('the page crashed');
        expect(background.status()).toMatchObject({ state: 'error' });
        expect(background.status().error).toContain('the page crashed');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(sessions.length).toBe(2);
        expect(background.status().state).toBe('running');
    });

    it('closes the old browser when restarted and when stopped, leaving no timers', async () => {
        background.serverStarted(URL_);
        await background.restart();
        await vi.advanceTimersByTimeAsync(0);
        await background.restart();
        await vi.advanceTimersByTimeAsync(0);
        expect(sessions[0]?.closed).toBe(true);
        expect(sessions[1]?.closed).toBe(false);

        // A crash report from the old session must not trigger anything.
        sessions[0]?.end('the browser exited');
        expect(background.status().state).toBe('running');

        await background.stop();
        expect(sessions[1]?.closed).toBe(true);
        expect(background.status().state).toBe('off');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stopping during a retry cancels it', async () => {
        launchError = new Error('boom');
        background.serverStarted(URL_);
        await background.restart();
        await vi.advanceTimersByTimeAsync(0);
        await background.stop();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(launches.length).toBe(1);
    });
});

describe('describeProblem', () => {
    it.each([
        ["Cannot find package 'playwright-core' imported from /x", 'npm ci'],
        ['browserType.launch: Executable doesn\'t exist at /home/st/.cache/ms-playwright/chromium_headless_shell-1248', 'npm run browser:install'],
        ['Host system is missing dependencies to run browsers.', 'npm run browser:deps'],
        ['error while loading shared libraries: libnss3.so: cannot open shared object file', 'npm run browser:deps'],
        ['page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8000/', 'Could not open SillyTavern at http://127.0.0.1:8000/'],
        ['Something odd\nwith details', 'Something odd'],
    ])('explains %s', (message, expected) => {
        expect(describeProblem(new Error(message), 'http://127.0.0.1:8000/')).toContain(expected);
    });
});
