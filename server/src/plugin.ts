import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Router } from 'express';
import { ConfigStore } from './config/store.js';
import { BridgeService } from './core/bridge-service.js';
import { createRng, randomSeed } from './core/random.js';
import { type Scheduler, systemScheduler } from './core/scheduler.js';
import { forwardEvents, registerRoutes } from './http/routes.js';
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
    scheduler?: Scheduler;
    heartbeatMs?: number;
}

export interface PluginHandle {
    readonly service: BridgeService;
    close(): Promise<void>;
}

/**
 * Composition root. Registers every route synchronously (SillyTavern only mounts a router that
 * already has routes when init resolves) and starts connecting without waiting for it.
 */
export async function createPlugin(router: Router, options: PluginOptions): Promise<PluginHandle> {
    const { logger } = options;
    const scheduler = options.scheduler ?? systemScheduler;
    const store = new ConfigStore(path.join(options.dataDir, 'config.json'), logger);
    const hub = new SseHub(scheduler, randomUUID, logger, options.heartbeatMs);

    // Routes first, so a failure further down still leaves the status endpoint mounted.
    let service: BridgeService | null = null;
    const deps = {
        get service(): BridgeService {
            if (!service) throw new Error('WhatsChat is still starting');
            return service;
        },
        store,
        hub,
        logger,
    };
    registerRoutes(router, deps);

    await store.load();
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
    const stopForwarding = forwardEvents(deps);
    service.start();

    let closing: Promise<void> | null = null;
    const running = service;
    return {
        service: running,
        close: () => {
            closing ??= (async () => {
                stopForwarding();
                hub.closeAll();
                await running.close();
            })();
            return closing;
        },
    };
}
