import type { Browser, ConsoleMessage, Page } from 'playwright-core';
import type { Logger } from '../util/logger.js';
import type { BrowserSession, Launcher } from './session.js';
import { WORKER_FLAG, WORKER_READY_FLAG } from './session.js';

/**
 * Requests the hidden copy must never make. Each browser tab keeps its own copy of
 * SillyTavern's settings and saves all of it at once, so a hidden copy that saved settings
 * would undo changes you make in your own tab. It's told the save worked.
 */
const BLOCKED_REQUESTS = /\/api\/settings\/save(?:[?#]|$)/;

/** Chromium flags that suit a headless server (and containers with a small /dev/shm). */
const CHROMIUM_ARGS = ['--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--mute-audio'];

/** Launches headless Chromium through Playwright and opens one page for SillyTavern. */
export const launchWithPlaywright: Launcher = async ({ executablePath, httpCredentials, logger }) => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
        headless: true,
        args: CHROMIUM_ARGS,
        timeout: 60_000,
        // SillyTavern handles these signals and closes us from exit(); don't race it.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        ...(executablePath ? { executablePath } : {}),
    });

    try {
        const context = await browser.newContext({
            ignoreHTTPSErrors: true, // SillyTavern's own SSL certificate is usually self-signed
            serviceWorkers: 'block',
            viewport: { width: 1280, height: 900 },
            ...(httpCredentials ? { httpCredentials } : {}),
        });
        await context.addInitScript({ content: `globalThis.${WORKER_FLAG} = true;` });
        await context.route(BLOCKED_REQUESTS, (route) =>
            route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
        );
        const page = await context.newPage();
        page.on('dialog', (dialog) => {
            dialog.dismiss().catch(() => undefined);
        });
        page.on('console', (message) => {
            forwardConsole(message, logger);
        });
        return createSession(browser, page);
    } catch (error) {
        await browser.close().catch(() => undefined);
        throw error;
    }
};

function createSession(browser: Browser, page: Page): BrowserSession {
    let ended = false;
    const endedListeners: ((reason: string) => void)[] = [];
    const end = (reason: string) => {
        if (ended) return;
        ended = true;
        for (const listener of endedListeners) listener(reason);
    };
    page.on('crash', () => {
        end('the page crashed');
    });
    page.on('close', () => {
        end('the page closed');
    });
    browser.on('disconnected', () => {
        end('the browser exited');
    });

    return {
        version: browser.version(),
        async open(url) {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        },
        currentUrl: () => page.url(),
        login(username, password) {
            return page.evaluate(
                async ({ handle, secret }) => {
                    const tokenResponse = await fetch('/csrf-token');
                    const { token } = (await tokenResponse.json()) as { token: string };
                    const response = await fetch('/api/users/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
                        body: JSON.stringify({ handle, password: secret }),
                    });
                    if (response.ok) return { ok: true as const };
                    let error = `HTTP ${String(response.status)}`;
                    try {
                        error = ((await response.json()) as { error?: string }).error ?? error;
                    } catch {
                        // keep the status
                    }
                    return { ok: false as const, error };
                },
                { handle: username, secret: password },
            );
        },
        async waitForWorker(timeoutMs) {
            await page.waitForFunction(`globalThis.${WORKER_READY_FLAG} === true`, undefined, {
                timeout: timeoutMs,
                polling: 500,
            });
        },
        onEnded(listener) {
            endedListeners.push(listener);
        },
        async close() {
            ended = true;
            await browser.close();
        },
    };
}

/** WhatsChat's own messages from the hidden page go to SillyTavern's console. */
function forwardConsole(message: ConsoleMessage, logger: Logger): void {
    const text = message.text();
    if (!text.includes('[WhatsChat]')) return;
    const line = `(background) ${text.replace('[WhatsChat] ', '')}`;
    if (message.type() === 'error') logger.error(line);
    else if (message.type() === 'warning') logger.warn(line);
    else if (message.type() === 'debug') logger.debug(line);
    else logger.info(line);
}
