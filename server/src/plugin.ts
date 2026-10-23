import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Router } from 'express';
import { BackgroundBrowser, type BackgroundStatus } from './background/background-browser.js';
import { LoginStore } from './background/login-store.js';
import { localServerUrl } from './background/server-url.js';
import type { Launcher } from './background/session.js';
import type { Config } from './config/schema.js';
import { ConfigStore } from './config/store.js';
import { BridgeService } from './core/bridge-service.js';
import { createRng, randomSeed } from './core/random.js';
import { type Scheduler, systemScheduler } from './core/scheduler.js';
import { forwardEvents, registerRoutes, type RouteDeps } from './http/routes.js';
import { SseHub } from './http/sse.js';
import type { MessagingTransport } from './transport/types.js';
import type { Logger } from './util/logger.js';

export interface TransportContext {
    /** Directory for the transport's own session files. */
    sessionDir: string;
    store: ConfigStore;
    scheduler: Scheduler;
    logger: Logger;
}

export interface PluginOptions {
    /** Holds config.json and the session folder. Must not be committed. */
    dataDir: string;
    logger: Logger;
    createTransport: (context: TransportContext) => MessagingTransport;
    /** Starts the hidden browser used for background replies. */
    launcher: Launcher;
    /** SillyTavern's server events (process.serverEvents), which announce the address it listens on. */
    serverEvents?: Pick<EventEmitter, 'on' | 'off'> | undefined;
    scheduler?: Scheduler;
    heartbeatMs?: number;
    /** How long a tab may be disconnected before its claimed batch is offered again. */
    clientGraceMs?: number;
}

export interface PluginHandle {
    readonly service: BridgeService;
    readonly background: BackgroundBrowser;
    close(): Promise<void>;
}

const BACKGROUND_OFF: BackgroundStatus = { enabled: false, state: 'off' };

/**
 * Composition root. Registers every route synchronously (SillyTavern only mounts a router that
 * already has routes when init resolves) and starts connecting without waiting for it.
 */
export async function createPlugin(router: Router, options: PluginOptions): Promise<PluginHandle> {
    const { logger } = options;
    const scheduler = options.scheduler ?? systemScheduler;
    const store = new ConfigStore(path.join(options.dataDir, 'config.json'), logger);
    const login = new LoginStore(path.join(options.dataDir, 'background-login.json'), logger);
    const hub = new SseHub(scheduler, randomUUID, logger, options.heartbeatMs, options.clientGraceMs);

    // Routes first, so a failure further down still leaves the status endpoint mounted.
    let service: BridgeService | null = null;
    let background: BackgroundBrowser | null = null;
    const deps: RouteDeps = {
        get service(): BridgeService {
            if (!service) throw new Error('WhatsChat is still starting');
            return service;
        },
        store,
        hub,
        logger,
        background: {
            handlesReplies: () => background?.handlesReplies() ?? false,
            status: () => background?.status() ?? BACKGROUND_OFF,
            restart: () => background?.restart() ?? Promise.resolve(),
            describeLogin: () => login.describe(),
            setLogin: (username, password) => login.set(username, password),
        },
    };
    registerRoutes(router, deps);

    await store.load();
    await login.load();
    const transport = options.createTransport({
        sessionDir: path.join(options.dataDir, 'auth'),
        store,
        scheduler,
        logger,
    });
    service = new BridgeService({
        transport,
        config: store,
        scheduler,
        rng: createRng(randomSeed()),
        logger,
        newId: randomUUID,
    });
    const forwarding = forwardEvents(deps);

    const hidden = new BackgroundBrowser({
        launcher: options.launcher,
        scheduler,
        logger,
        settings: () => store.get().background,
        login: () => login.get(),
    });
    background = hidden;
    const offBackground = hidden.onStatus(() => {
        forwarding.announce();
    });
    const offConfig = store.onChange((next, previous) => {
        if (backgroundSettingsChanged(next, previous)) void hidden.restart();
    });
    const onServerStarted = (event: { url?: URL | string } | undefined) => {
        const url = event?.url ? localServerUrl(event.url) : null;
        if (url) hidden.serverStarted(url);
    };
    options.serverEvents?.on('server-started', onServerStarted);

    service.start();
    void hidden.restart();

    let closing: Promise<void> | null = null;
    const running = service;
    return {
        service: running,
        background: hidden,
        close: () => {
            closing ??= (async () => {
                options.serverEvents?.off('server-started', onServerStarted);
                offConfig();
                offBackground();
                forwarding.stop();
                hub.closeAll();
                await hidden.stop();
                await running.close();
            })();
            return closing;
        },
    };
}

function backgroundSettingsChanged(next: Config, previous: Config): boolean {
    const a = next.background;
    const b = previous.background;
    return a.enabled !== b.enabled || a.executablePath !== b.executablePath || a.url !== b.url;
}
